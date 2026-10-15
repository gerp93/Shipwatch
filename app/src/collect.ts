// Gathers what the report shows, in two steps so the window need not wait for the slow one: the dashboard's repos
// (a few seconds), then the stats history (the first run reads years of merged PRs). This is the app's counterpart
// of the Claude pane's refresh: it calls the same core functions, so both read GitHub the same way.

import { buildBoard } from '../../src/core/boardService'
import type { InfraVerdicts } from '../../src/core/boardService'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { adviseOnLimit, isRateLimit } from '../../src/core/budget'
import type { Budget } from '../../src/core/budget'
import { connect, fetchApiLimits, resolveOwner } from '../../src/core/github'
import { fetchRecentPrs } from '../../src/core/recent'
import type { IO, Store } from '../../src/core/ports'
import type { ReportData } from '../../src/core/report'
import { ALL_TIME } from '../../src/core/stats'
import { loadStatsCache, refreshStats } from '../../src/core/statsService'
import type { Access } from '../../src/core/ports'
import type { RecentPr, RepoView, StatsBoard } from '../../src/core/types'

import type { AppConfig } from './config'

const DAY_MS = 86_400_000

/**
 * The stats history reaches back to the account's first repo, so every range the report offers has its data.
 * The first run loads all of it (a few minutes for years of work); after that only what is new is fetched.
 */
const STATS_RANGE = ALL_TIME

const EMPTY_STATS: StatsBoard = {
  range: STATS_RANGE,
  mode: 'combined',
  hidden: [],
  prs: [],
  repos: [],
  coveredFrom: '',
  coveredThrough: '',
  you: '',
  isLoading: false,
  progress: '',
  error: null,
  updatedAt: 0,
}

export type CollectDeps = {
  io: IO
  store: Store
  config: AppConfig
  now: number
  infraVerdicts: InfraVerdicts
  onProgress?: (text: string) => void
}

/** What the first step learned: who, their repos as the dashboard shows them, and the PRs opened in the last hour. */
export type DashboardRead = {
  owner: string
  repos: RepoView[]
  /** Absent when the (best-effort) read of the last hour's PRs failed. */
  recent?: RecentPr[]
  /** What GitHub's GraphQL allowance had left after the read, for pacing the next one. */
  budget?: Budget
  access: Access
}

/**
 * A request GitHub refused for rate limiting. The message is what GitHub's rate-limit status reports (points
 * left, the reset time) and `retryInMs` is the time until that reset, when the caller should ask again.
 */
export class RateLimited extends Error {
  constructor(
    message: string,
    readonly retryInMs: number,
  ) {
    super(message)
  }
}

/** A rate-limit failure turned into one that carries when to try again; anything else as it was. */
const explain = async (io: IO, access: Access, err: unknown): Promise<Error> => {
  const message = err instanceof Error ? err.message : String(err)
  if (!isRateLimit(message)) return err instanceof Error ? err : new Error(message)
  const advice = adviseOnLimit((await fetchApiLimits(io, access))?.graphql, Date.now())
  return new RateLimited(advice.message, advice.retryInMs)
}

export const HOUR_MS = 60 * 60_000

/**
 * Step one: the dashboard. Fast. When GitHub refuses a read for rate limiting this throws `RateLimited`, saying
 * what GitHub's status reports and when it resets, so the caller can show that and ask again then. The last
 * hour's PRs are read too, best effort.
 */
export const collectDashboard = async (deps: CollectDeps): Promise<DashboardRead> => {
  const { io, config, now } = deps
  deps.onProgress?.('Connecting to GitHub...')
  const access = await connect(io, config.token)
  try {
    const owner = await resolveOwner(io, access, config.owner)
    deps.onProgress?.('Reading repos...')
    let budget: Budget | undefined
    const repos = await buildBoard(
      io,
      access,
      {
        owner,
        count: config.count,
        includeForks: config.includeForks,
        ignore: new Set(config.ignore.map(n => n.toLowerCase())),
        staleMs: config.staleDays * DAY_MS,
        onBudget: b => void (budget = b),
      },
      now,
      deps.infraVerdicts,
    )
    let recent: RecentPr[] | undefined
    try {
      recent = await fetchRecentPrs(io, access, owner, now - HOUR_MS, b => void (budget = b))
    } catch {
      // The clock's rim is a bonus; the dashboard does not wait on it.
    }
    return { owner, repos, recent, budget, access }
  } catch (err) {
    throw await explain(io, access, err)
  }
}

/** What the app keeps of the last dashboard it read, so the next start can show it at once. */
export type SavedDashboard = { owner: string; repos: RepoView[]; recent?: RecentPr[]; at: number }

/** The dashboard saved by an earlier run, or undefined if there is none or it is not readable. */
export const loadSavedDashboard = async (path: string): Promise<SavedDashboard | undefined> => {
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as Partial<SavedDashboard> | null
    if (!v || typeof v.owner !== 'string' || !Array.isArray(v.repos) || typeof v.at !== 'number') return undefined
    return { owner: v.owner, repos: v.repos, recent: Array.isArray(v.recent) ? v.recent : undefined, at: v.at }
  } catch {
    return undefined
  }
}

/** Keeps the dashboard for the next start; a failure to write is not worth stopping for. */
export const saveDashboard = async (path: string, dashboard: SavedDashboard): Promise<void> => {
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(dashboard), 'utf8')
    await rename(tmp, path)
  } catch {
    // The next start just has nothing saved to show.
  }
}

/** The stats history kept from earlier runs: instant, and what the report shows while the rest loads. */
export const savedStats = async (deps: CollectDeps, owner: string): Promise<StatsBoard> => {
  const saved = await loadStatsCache(deps.store, owner, deps.config.aiNames)
  return saved ? { ...EMPTY_STATS, ...saved } : { ...EMPTY_STATS }
}

/**
 * Step two: brings the stats history up to date, reading only what is not already held, and hands the history
 * so far to `onPartial` as each stretch arrives. A failure (a rate limit part way through a first load) does not
 * lose what was read: it is kept, and the error comes back beside the stats for the caller to show.
 */
export const collectStats = async (
  deps: CollectDeps,
  read: DashboardRead,
  start: StatsBoard,
  onPartial?: (stats: ReportData['stats']) => void,
): Promise<{ stats: StatsBoard; error: string | null }> => {
  const { io, store, config, now } = deps
  let stats = start
  try {
    const done = await refreshStats(
      {
        io,
        access: read.access,
        store,
        owner: read.owner,
        aiNames: config.aiNames,
        now,
        onProgress: text => deps.onProgress?.(text),
        wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
        onPartial: (prs, you, repos) => {
          stats = { ...stats, prs, you, repos }
          onPartial?.({ prs, you, repos })
        },
      },
      stats,
    )
    return { stats: { ...stats, ...done }, error: null }
  } catch (err) {
    return { stats, error: (await explain(io, read.access, err)).message }
  }
}

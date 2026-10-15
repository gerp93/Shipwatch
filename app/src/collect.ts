// Gathers what the report shows, in two steps so the window need not wait for the slow one: the dashboard's repos
// (a few seconds), then the stats history (the first run reads years of merged PRs). This is the app's counterpart
// of the Claude pane's refresh: it calls the same core functions, so both read GitHub the same way.

import { buildBoard } from '../../src/core/boardService'
import type { InfraVerdicts } from '../../src/core/boardService'
import { adviseOnLimit, isRateLimit } from '../../src/core/budget'
import { connect, fetchGraphqlLimit, resolveOwner } from '../../src/core/github'
import type { IO, Store } from '../../src/core/ports'
import type { ReportData } from '../../src/core/report'
import { ALL_TIME } from '../../src/core/stats'
import { loadStatsCache, refreshStats } from '../../src/core/statsService'
import type { Access } from '../../src/core/ports'
import type { RepoView, StatsBoard } from '../../src/core/types'

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

/** What the first step learned: who, and their repos as the dashboard shows them. */
export type DashboardRead = { owner: string; repos: RepoView[]; access: Access }

/** A rate-limit failure said plainly, which limit it was and when to try again; anything else as it was. */
const explain = async (io: IO, access: Access, err: unknown): Promise<Error> => {
  const message = err instanceof Error ? err.message : String(err)
  if (isRateLimit(message)) return new Error(adviseOnLimit(await fetchGraphqlLimit(io, access), Date.now()).message)
  return err instanceof Error ? err : new Error(message)
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
const DASHBOARD_TRIES = 4

/**
 * Step one: the dashboard. Fast, and enough to show the window. A short-term burst limit (GitHub slowing
 * requests while the hourly allowance still has points) is waited out a few times; anything else throws a
 * message that says what happened.
 */
export const collectDashboard = async (deps: CollectDeps): Promise<DashboardRead> => {
  const { io, config, now } = deps
  deps.onProgress?.('Connecting to GitHub...')
  const access = await connect(io, config.token)
  for (let attempt = 1; ; attempt++) {
    try {
      const owner = await resolveOwner(io, access, config.owner)
      deps.onProgress?.('Reading repos...')
      const repos = await buildBoard(
        io,
        access,
        {
          owner,
          count: config.count,
          includeForks: config.includeForks,
          ignore: new Set(config.ignore.map(n => n.toLowerCase())),
          staleMs: config.staleDays * DAY_MS,
        },
        now,
        deps.infraVerdicts,
      )
      return { owner, repos, access }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!isRateLimit(message)) throw err
      const advice = adviseOnLimit(await fetchGraphqlLimit(io, access), Date.now())
      if (!advice.burst || attempt >= DASHBOARD_TRIES) throw new Error(advice.message)
      deps.onProgress?.(`GitHub is briefly slowing requests; trying again in ${Math.round(advice.retryInMs / 1000)} s (try ${attempt} of ${DASHBOARD_TRIES - 1})...`)
      await sleep(advice.retryInMs)
    }
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

// Gathers everything the report shows: the dashboard's repos and the stats history. This is the app's
// counterpart of the Claude pane's refresh: it calls the same core functions, so both read GitHub the same way.

import { buildBoard } from '../../src/core/boardService'
import type { InfraVerdicts } from '../../src/core/boardService'
import { connect, resolveOwner } from '../../src/core/github'
import type { IO, Store } from '../../src/core/ports'
import type { ReportData } from '../../src/core/report'
import { loadStatsCache, refreshStats } from '../../src/core/statsService'
import type { StatsBoard } from '../../src/core/types'

import type { AppConfig } from './config'

const DAY_MS = 86_400_000

/** The stats history covers a year, the longest range the report offers; only what is new is fetched after the first run. */
const STATS_RANGE = 365

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

/**
 * Reads the dashboard, then brings the stats history up to date. A failure in the stats (a rate limit part
 * way through a first load, say) does not lose the dashboard: the report is built from what was read, and the
 * stats error is returned beside it for the caller to mention.
 */
export const collect = async (deps: CollectDeps): Promise<{ data: ReportData; statsError: string | null }> => {
  const { io, store, config, now } = deps
  deps.onProgress?.('Connecting to GitHub...')
  const access = await connect(io, config.token)
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

  let stats: StatsBoard = { ...EMPTY_STATS }
  const saved = await loadStatsCache(store, owner, config.aiNames)
  if (saved) stats = { ...stats, ...saved }
  let statsError: string | null = null
  try {
    const done = await refreshStats(
      {
        io,
        access,
        store,
        owner,
        aiNames: config.aiNames,
        now,
        onProgress: text => deps.onProgress?.(text),
        onPartial: (prs, you) => void (stats = { ...stats, prs, you }),
      },
      stats,
    )
    stats = { ...stats, ...done }
  } catch (err) {
    statsError = err instanceof Error ? err.message : String(err)
  }

  return {
    data: { generatedAt: now, board: { owner, repos }, stats: { prs: stats.prs, repos: stats.repos, you: stats.you } },
    statsError,
  }
}

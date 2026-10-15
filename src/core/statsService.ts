import type { Access, IO, Store } from './ports'
import { dateOf, mergeById, planFetch, sinceFor, summarizePr } from './stats'
import { fetchMergedPrs, fetchReposCreated, fetchViewerLogin } from './statsFetch'
import type { PrSummary, StatsBoard } from './types'

/** Bump when what a stored PR summary holds changes, so old ones are fetched again. */
export const STATS_VERSION = 1
/** Stats younger than this are not fetched again just because they were asked for. */
export const STATS_FRESH_MS = 10 * 60_000
/** Merged PRs older than this are dropped from the store: the longest range is a year. */
export const STATS_KEEP_DAYS = 400

const DAY_MS = 86_400_000

/** What is worth keeping between sessions. */
export type StatsCache = Pick<StatsBoard, 'prs' | 'repos' | 'coveredFrom' | 'coveredThrough' | 'you'>

// A stored summary is only as good as the rules that made it: a changed list of extra AI names, or a
// new STATS_VERSION, means they must be fetched and attributed again.
const signatureOf = (aiNames: readonly string[]) => `${STATS_VERSION}:${aiNames.join(',')}`
const storeKey = (owner: string) => `shipwatch.stats:${owner}`

/** The history kept by an earlier session, or null if there is none or it was made by other rules. */
export const loadStatsCache = async (store: Store, owner: string, aiNames: readonly string[]): Promise<StatsCache | null> => {
  const saved = (await store.get(storeKey(owner))) as (Partial<StatsCache> & { signature?: string }) | null | undefined
  if (!saved || saved.signature !== signatureOf(aiNames) || !Array.isArray(saved.prs)) return null
  return {
    prs: saved.prs,
    repos: saved.repos ?? [],
    coveredFrom: saved.coveredFrom ?? '',
    coveredThrough: saved.coveredThrough ?? '',
    you: saved.you ?? '',
  }
}

/** Whether what is held already covers the range and is recent enough not to ask again. */
export const statsAreFresh = (s: Pick<StatsBoard, 'updatedAt' | 'coveredFrom' | 'range'>, now: number): boolean =>
  s.updatedAt > 0 && now - s.updatedAt < STATS_FRESH_MS && !!s.coveredFrom && s.coveredFrom <= dateOf(sinceFor(s.range, now))

export type StatsDeps = {
  io: IO
  access: Access
  store: Store
  owner: string
  /** Extra names to count as AI (see `aiFamilyOf`). */
  aiNames: readonly string[]
  now: number
  /** What the loader is doing, in words, as it goes. */
  onProgress?: (text: string) => void
  /** The history so far, after each month-sized window arrives, so a long load can show what it has. */
  onPartial?: (prs: PrSummary[], you: string) => void
}

/**
 * Brings the merged-PR history up to date for the range in `s` and reads the repos' creation dates, then
 * keeps the result in the store. What is already held is not fetched again: only the days before it, if
 * the range reaches further back, and the days since. Merged PRs never change, so each is looked up once.
 */
export const refreshStats = async (deps: StatsDeps, s: StatsBoard): Promise<StatsCache> => {
  const { io, access, store, owner, aiNames, now } = deps
  deps.onProgress?.('Starting...')
  const you = s.you || (await fetchViewerLogin(io, access))
  const plan = planFetch(s.coveredFrom, s.coveredThrough, now, sinceFor(s.range, now))
  let prs = s.prs
  for (let i = 0; i < plan.windows.length; i++) {
    const w = plan.windows[i]!
    const raw = await fetchMergedPrs(io, access, owner, w.from, w.to, (loaded, total) =>
      deps.onProgress?.(`Loading merged PRs ${w.from} to ${w.to}: ${loaded} of ${total} (part ${i + 1} of ${plan.windows.length})`),
    )
    prs = mergeById(prs, raw.map(r => summarizePr(r, you, aiNames)))
    deps.onPartial?.(prs, you)
  }
  const repos = await fetchReposCreated(io, access, owner)
  prs = prs.filter(p => Date.parse(p.mergedAt) >= now - STATS_KEEP_DAYS * DAY_MS)
  const cache: StatsCache = { prs, repos, you, coveredFrom: plan.coveredFrom, coveredThrough: plan.coveredThrough }
  await store.set(storeKey(owner), { ...cache, signature: signatureOf(aiNames) })
  return cache
}

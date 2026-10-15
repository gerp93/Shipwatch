import type { Access, IO, Store } from './ports'
import { RATE_LIMITED, rateLimitMessage } from './budget'
import { fetchGraphqlReset } from './github'
import { dateOf, earliestKnown, mergeById, planFetch, rangeSince, summarizePr } from './stats'
import { fetchMergedPrs, fetchReposCreated, fetchViewerLogin } from './statsFetch'
import type { PrSummary, RepoCreated, StatsBoard } from './types'

/** Bump when what a stored PR summary holds changes, so old ones are fetched again. */
export const STATS_VERSION = 1
/** Stats younger than this are not fetched again just because they were asked for. */
export const STATS_FRESH_MS = 10 * 60_000
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
export const statsAreFresh = (
  s: Pick<StatsBoard, 'updatedAt' | 'coveredFrom' | 'range'> & Partial<Pick<StatsBoard, 'repos' | 'prs'>>,
  now: number,
): boolean =>
  s.updatedAt > 0 &&
  now - s.updatedAt < STATS_FRESH_MS &&
  !!s.coveredFrom &&
  s.coveredFrom <= dateOf(rangeSince(s.range, now, earliestKnown(s.repos ?? [], s.prs ?? [])))

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
  onPartial?: (prs: PrSummary[], you: string, repos: RepoCreated[]) => void
  /**
   * Waits `ms`, for the host to supply (the core has no timers of its own). With it, a window that GitHub
   * refuses for rate limiting is tried again after a pause; without it, that failure ends the load.
   */
  wait?: (ms: number) => Promise<void>
}

/** A pause when GitHub says to slow down and does not say until when. */
const RATE_LIMIT_PAUSE_MS = 60_000
const RATE_LIMIT_TRIES = 4
/** The longest wait for an allowance reset; a longer one ends the load, which resumes from what is kept. */
const RATE_LIMIT_MAX_WAIT_MS = 20 * 60_000

/**
 * Brings the merged-PR history up to date for the range in `s` and reads the repos' creation dates, then
 * keeps the result in the store. What is already held is not fetched again: only the days before it, if
 * the range reaches further back, and the days since. Merged PRs never change, so each is looked up once.
 */
export const refreshStats = async (deps: StatsDeps, s: StatsBoard): Promise<StatsCache> => {
  const { io, access, store, owner, aiNames, now } = deps
  deps.onProgress?.('Starting...')
  const you = s.you || (await fetchViewerLogin(io, access))
  // The repos come first: an all-time range starts at the oldest of them.
  const repos = await fetchReposCreated(io, access, owner)
  const plan = planFetch(s.coveredFrom, s.coveredThrough, now, rangeSince(s.range, now, earliestKnown(repos, s.prs)))
  const yesterday = dateOf(now - 86_400_000)
  let prs = s.prs
  let cover = { from: s.coveredFrom, through: s.coveredThrough }
  const save = (): Promise<void> => store.set(storeKey(owner), { prs, repos, you, coveredFrom: cover.from, coveredThrough: cover.through, signature: signatureOf(aiNames) })

  // Newest first, so the recent history, which is what most people look at, lands before the old, and so an
  // interrupted load (a rate limit, a closed window) leaves one unbroken stretch from today backwards that the
  // next run extends. Windows after the held history come first, then the older ones from newest to oldest.
  const held = !!s.coveredFrom && !!s.coveredThrough
  const newer = held ? plan.windows.filter(w => w.from > s.coveredThrough) : []
  const older = (held ? plan.windows.filter(w => w.to < s.coveredFrom) : plan.windows).slice().reverse()
  const ordered = [...newer, ...older]

  for (let i = 0; i < ordered.length; i++) {
    const w = ordered[i]!
    const progress = (loaded: number, total: number): void =>
      deps.onProgress?.(`Loading merged PRs ${w.from} to ${w.to}: ${loaded} of ${total} (part ${i + 1} of ${ordered.length})`)
    let raw: Awaited<ReturnType<typeof fetchMergedPrs>>
    for (let attempt = 1; ; attempt++) {
      try {
        raw = await fetchMergedPrs(io, access, owner, w.from, w.to, progress)
        break
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (!deps.wait || !RATE_LIMITED.test(message)) throw err
        // The hourly allowance resets at a known time: wait for it if that is soon, else stop (what is kept stays).
        const resetAt = await fetchGraphqlReset(io, access)
        const untilReset = resetAt ? resetAt - Date.now() : undefined
        if (untilReset !== undefined && untilReset > RATE_LIMIT_MAX_WAIT_MS) throw new Error(rateLimitMessage(resetAt, Date.now()))
        // However it is told, give up after a few tries rather than wait for ever on a limit that does not lift.
        if (attempt >= RATE_LIMIT_TRIES) throw err
        const pause = untilReset !== undefined && untilReset > 0 ? untilReset + 5_000 : RATE_LIMIT_PAUSE_MS
        deps.onProgress?.(
          untilReset !== undefined && untilReset > 0
            ? `GitHub's hourly allowance is used up; waiting ${Math.ceil(pause / 60_000)} min for it to reset, at ${w.from} to ${w.to}...`
            : `GitHub asked us to slow down; waiting a minute (try ${attempt} of ${RATE_LIMIT_TRIES - 1}) at ${w.from} to ${w.to}...`,
        )
        await deps.wait(pause)
      }
    }
    prs = mergeById(prs, raw.map(r => summarizePr(r, you, aiNames)))
    // Coverage grows from what is held outwards, so it is always one unbroken stretch.
    if (!cover.from || !cover.through) cover = { from: w.from, through: yesterday }
    else if (w.to < cover.from) cover = { ...cover, from: w.from }
    else cover = { ...cover, through: w.to < yesterday ? w.to : yesterday }
    deps.onPartial?.(prs, you, repos)
    // Keep what has arrived, so a failure further back loses nothing already fetched.
    if (raw.length > 0) await save()
  }
  const cache: StatsCache = { prs, repos, you, coveredFrom: plan.coveredFrom, coveredThrough: plan.coveredThrough }
  await save()
  return cache
}

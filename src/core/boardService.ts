import { analyze, byUrgency, markInfra } from './analyze'
import type { Budget } from './budget'
import { fetchActivity, fetchInfraFailure, fetchRepos } from './github'
import type { Access, IO } from './ports'
import type { RepoView } from './types'

/** How the dashboard reads a repo's state; the same for every outlet. */
export const BOARD_DEFAULTS = {
  /** A missing release this soon after a merge reads as "awaiting", later as "not every commit ships". */
  recentMs: 6 * 60 * 60 * 1000,
  /** A repo whose default branch was updated this recently, with nothing to act on, is Recently merged rather than Quiet. */
  activeMs: 3 * 24 * 60 * 60 * 1000,
  /** How long a runner-outage verdict for a commit is trusted: a re-run can change it. */
  infraTtlMs: 5 * 60_000,
  /** Most building repos asked which workflow runs are in flight (one request each). */
  maxActivityLookups: 8,
}

export type BoardOptions = {
  owner: string
  /** Most recently pushed repos to read (1-100). */
  count: number
  includeForks: boolean
  /** Lower-case repo names to leave out. */
  ignore: ReadonlySet<string>
  staleMs: number
  /** Told what GitHub's allowance has left after the read, so the caller can pace itself (see budget.ts). */
  onBudget?: (budget: Budget) => void
}

/** Per `repo:commit`, whether a failed main build was GitHub's outage, and when that was last asked. */
export type InfraVerdicts = Map<string, { isInfra: boolean; at: number }>

/**
 * The dashboard's repos, most urgent first: read from GitHub, judged (`analyze`), failed default-branch
 * builds checked for a runner outage, and running ones given the workflow runs in flight. What to do
 * about the result (toasts, a status line, a fix prompt) is each outlet's own business.
 */
export const buildBoard = async (
  io: IO,
  access: Access,
  options: BoardOptions,
  now: number,
  infraVerdicts: InfraVerdicts,
): Promise<RepoView[]> => {
  const raw = await fetchRepos(io, access, options.owner, options.count, options.includeForks, options.onBudget)
  const repos = raw
    .filter(r => !r.isArchived && !options.ignore.has(r.name.toLowerCase()))
    .map(r => analyze(r, now, BOARD_DEFAULTS.recentMs, options.staleMs, BOARD_DEFAULTS.activeMs))
    .sort(byUrgency)

  for (let i = 0; i < repos.length; i++) {
    const r = repos[i]!
    if (r.level !== 'fail' || r.headline !== 'main build failing' || r.isStale) continue
    const key = `${r.name}:${r.headOid}`
    let verdict = infraVerdicts.get(key)
    if (!verdict || now - verdict.at > BOARD_DEFAULTS.infraTtlMs) {
      let isInfra = false
      try {
        isInfra = await fetchInfraFailure(io, access, options.owner, r.name, r.headOid)
      } catch {
        // Can't tell: treat it as the code's failure rather than hide it.
      }
      verdict = { isInfra, at: now }
      infraVerdicts.set(key, verdict)
    }
    repos[i] = markInfra(r, verdict.isInfra)
  }

  for (const r of repos.filter(r => r.level === 'running').slice(0, BOARD_DEFAULTS.maxActivityLookups)) {
    try {
      r.activity = await fetchActivity(io, access, options.owner, r.name)
    } catch {
      // The headline already says it is building; run names are a bonus.
    }
  }
  return repos
}

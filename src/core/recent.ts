// The PRs opened in the last stretch of time (an hour, for the ship clock), open or already merged or closed.
// One cheap search: no commits, just each PR's state, the rollup of its latest commit's checks, and when its repo last
// released (so a merged PR can be told from one that has shipped).

import type { Budget } from './budget'
import { graphql } from './github'
import { isParked } from './parked'
import type { Access, IO } from './ports'
import type { Checks, RecentPr, RepoView } from './types'

const QUERY = `
query($q:String!){
  rateLimit{ cost remaining limit resetAt }
  search(query:$q, type:ISSUE, first:100){
    nodes{
      ... on PullRequest{
        number title url createdAt mergedAt isDraft state
        repository{ name latestRelease{ publishedAt } }
        commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
      }
    }
  }
}`

const checksOf = (state: unknown): Checks => {
  switch (state) {
    case 'SUCCESS':
      return 'passing'
    case 'FAILURE':
    case 'ERROR':
      return 'failing'
    case 'PENDING':
    case 'EXPECTED':
      return 'running'
    default:
      return 'none'
  }
}

/** The most open PRs the dashboard reads per repo; a repo at this count may have more than it lists. */
const BOARD_PRS_PER_REPO = 10

/**
 * The recent PRs the dashboard's repo list disagrees with, as `repo#number:state` (the state is the recent read's,
 * so a PR is named again only if it changes again). The clock's PRs are read every minute and the repo list less
 * often, so for a while a PR can be merged on the clock yet "ready to merge" in the list. Those are:
 * a PR the list still shows open that has been merged or closed, and an open PR the list does not show yet.
 * Repos the list does not cover are not judged.
 */
export const boardLag = (repos: ReadonlyArray<Pick<RepoView, 'name' | 'prs'>>, recent: readonly RecentPr[]): string[] => {
  const byName = new Map(repos.map(r => [r.name, r]))
  const out: string[] = []
  for (const p of recent) {
    const repo = byName.get(p.repo)
    if (!repo) continue
    const listed = repo.prs.some(x => x.number === p.number)
    if ((p.state !== 'open' && listed) || (p.state === 'open' && !listed && repo.prs.length < BOARD_PRS_PER_REPO)) out.push(`${p.repo}#${p.number}:${p.state}`)
  }
  return out
}

/** The ISO instant GitHub's search wants, to the second and in UTC. */
const searchTime = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z')

/**
 * Every PR opened by anyone in `owner`'s repos at or after `sinceMs`, newest first (up to 100). Costs one point.
 * `onBudget` is told what GitHub's allowance has left, as for the other reads.
 */
export const fetchRecentPrs = async (
  io: IO,
  access: Access,
  owner: string,
  sinceMs: number,
  onBudget?: (budget: Budget) => void,
): Promise<RecentPr[]> => {
  const out = await graphql(io, access, QUERY, { q: `user:${owner} is:pr created:>=${searchTime(sinceMs)}` })
  const rl = out?.data?.rateLimit
  if (rl && typeof rl.remaining === 'number' && typeof rl.limit === 'number') {
    onBudget?.({ cost: Number(rl.cost) || 1, remaining: rl.remaining, limit: rl.limit, resetAt: Date.parse(rl.resetAt) || 0 })
  }
  const nodes: unknown[] | undefined = out?.data?.search?.nodes
  if (!nodes) throw new Error(out?.errors?.[0]?.message ?? 'GitHub search failed')
  const prs: RecentPr[] = []
  for (const n of nodes as Array<Record<string, any> | null>) {
    if (!n || typeof n.number !== 'number' || typeof n.createdAt !== 'string' || !n.repository?.name) continue
    const state = n.state === 'MERGED' ? 'merged' : n.state === 'CLOSED' ? 'closed' : 'open'
    prs.push({
      repo: String(n.repository.name),
      number: n.number,
      title: String(n.title ?? ''),
      url: String(n.url ?? ''),
      createdAt: n.createdAt,
      state,
      isDraft: n.isDraft === true,
      parked: isParked(String(n.title ?? ''), n.isDraft === true),
      checks: state === 'open' ? checksOf(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state) : 'none',
      mergedAt: typeof n.mergedAt === 'string' ? n.mergedAt : null,
      releasedAt: typeof n.repository.latestRelease?.publishedAt === 'string' ? n.repository.latestRelease.publishedAt : null,
    })
  }
  return prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

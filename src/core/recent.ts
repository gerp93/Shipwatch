// The PRs opened in the last stretch of time (an hour, for the ship clock), open or already merged or closed.
// One cheap search: no commits, just each PR's state and the rollup of its latest commit's checks.

import type { Budget } from './budget'
import { graphql } from './github'
import type { Access, IO } from './ports'
import type { Checks, RecentPr } from './types'

const QUERY = `
query($q:String!){
  rateLimit{ cost remaining limit resetAt }
  search(query:$q, type:ISSUE, first:100){
    nodes{
      ... on PullRequest{
        number title url createdAt mergedAt isDraft state
        repository{ name }
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
      checks: state === 'open' ? checksOf(n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state) : 'none',
      mergedAt: typeof n.mergedAt === 'string' ? n.mergedAt : null,
    })
  }
  return prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

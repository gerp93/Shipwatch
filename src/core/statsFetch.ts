import type { RepoCreated } from './types'
import { graphql } from './github'
import type { Access, IO } from './ports'
import type { RawMergedPr } from './stats'

// Merged PRs, with the identity and size of each commit. GitHub's search returns at most 1000 results
// for one query, so callers ask for a month at a time (see windowsBetween in stats.ts). 25 PRs a page
// keeps each answer small: every PR carries up to 100 commits.
const MERGED_QUERY = `
query($q:String!,$after:String){
  search(query:$q, type:ISSUE, first:25, after:$after){
    issueCount
    pageInfo{ hasNextPage endCursor }
    nodes{
      ... on PullRequest{
        id mergedAt
        repository{ name }
        commits(first:100){
          nodes{
            commit{
              message additions deletions
              parents{ totalCount }
              author{ name email user{ login } }
              authors(first:5){ nodes{ name email user{ login } } }
            }
          }
        }
      }
    }
  }
}`

const REPOS_QUERY = `
query($owner:String!,$after:String){
  repositoryOwner(login:$owner){
    repositories(first:100, after:$after, orderBy:{field:CREATED_AT,direction:DESC}){
      pageInfo{ hasNextPage endCursor }
      nodes{ name createdAt isArchived isFork }
    }
  }
}`

/** The signed-in account's login. */
export const fetchViewerLogin = async (io: IO, access: Access): Promise<string> => {
  const out = await graphql(io, access, 'query{ viewer{ login } }', {})
  const login = out?.data?.viewer?.login
  if (!login) throw new Error('Could not tell which GitHub account is signed in.')
  return login
}

/**
 * Every PR merged into a repo owned by `owner` between two dates (YYYY-MM-DD, inclusive; `to` null
 * for no upper limit), whoever opened it. `onPage` is told how many have come in against the total.
 */
export const fetchMergedPrs = async (
  io: IO,
  access: Access,
  owner: string,
  from: string,
  to: string | null,
  onPage?: (loaded: number, total: number) => void,
): Promise<RawMergedPr[]> => {
  const query = `user:${owner} is:pr is:merged merged:${from}..${to ?? '*'}`
  const found: RawMergedPr[] = []
  let after: string | null = null
  for (let page = 0; page < 60; page++) {
    const vars: Record<string, string | number | boolean | null> = { q: query, after }
    const out = await graphql(io, access, MERGED_QUERY, vars)
    const search = out?.data?.search
    if (!search) throw new Error(out?.errors?.[0]?.message ?? 'GitHub search failed')
    for (const node of search.nodes ?? []) if (node?.id && node.mergedAt) found.push(node as RawMergedPr)
    onPage?.(found.length, search.issueCount ?? found.length)
    if (!search.pageInfo?.hasNextPage) break
    after = search.pageInfo.endCursor
  }
  return found
}

/** Every repo `owner` has, with when it was created (newest first), up to 300. */
export const fetchReposCreated = async (io: IO, access: Access, owner: string): Promise<RepoCreated[]> => {
  const found: RepoCreated[] = []
  let after: string | null = null
  for (let page = 0; page < 3; page++) {
    const vars: Record<string, string | number | boolean | null> = { owner, after }
    const out = await graphql(io, access, REPOS_QUERY, vars)
    const repos = out?.data?.repositoryOwner?.repositories
    if (!repos) throw new Error(out?.errors?.[0]?.message ?? `No repositories found for ${owner}`)
    for (const n of repos.nodes ?? []) {
      if (n?.name && n.createdAt) found.push({ name: n.name, createdAt: n.createdAt, isArchived: !!n.isArchived, isFork: !!n.isFork })
    }
    if (!repos.pageInfo?.hasNextPage) break
    after = repos.pageInfo.endCursor
  }
  return found
}

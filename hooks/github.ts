import type { RawRepo } from './analyze'

/**
 * How this file reaches the outside world. register.tsx fills it with
 * `$.process.run` and `$.http.fetch` so `$` never leaves that file.
 */
export type IO = {
  run: (
    argv: readonly string[],
    init?: { timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  fetch: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ status: number; ok: boolean; text: string }>
}

export type Access = { source: 'gh' | 'token'; token: string }

const QUERY = `
query($owner:String!,$n:Int!,$fork:Boolean){
  repositoryOwner(login:$owner){
    repositories(first:$n, isFork:$fork, orderBy:{field:PUSHED_AT,direction:DESC}){
      nodes{
        name isArchived isFork pushedAt url
        defaultBranchRef{ name target{ ... on Commit{ oid committedDate statusCheckRollup{ state } } } }
        latestRelease{ tagName publishedAt }
        pullRequests(states:OPEN, first:10, orderBy:{field:UPDATED_AT,direction:DESC}){
          nodes{
            number title url isDraft headRefName updatedAt mergeable
            commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
          }
        }
      }
    }
  }
}`

const VIEWER = 'query{ viewer{ login } }'

const parse = (text: string): any => {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('GitHub returned something that was not JSON')
  }
}

/**
 * Picks how to reach GitHub: the `gh` CLI when it can run and is signed in
 * (no token handled here), else the configured token over HTTPS. Rejects with
 * a message that says what to fix.
 */
export const connect = async (io: IO, token: string): Promise<Access> => {
  try {
    const probe = await io.run(['gh', 'auth', 'status'], { timeoutMs: 15000 })
    if (probe.exitCode === 0) return { source: 'gh', token: '' }
  } catch {
    // gh missing, or process access unavailable on this surface: fall through to the token
  }
  if (token) return { source: 'token', token }
  throw new Error('Cannot reach GitHub: install and sign in to the gh CLI (`gh auth login`), or set the githubToken option.')
}

const graphql = async (io: IO, access: Access, query: string, vars: Record<string, string | number | boolean | null>) => {
  if (access.source === 'gh') {
    const argv = ['gh', 'api', 'graphql', '-f', `query=${query}`]
    for (const [k, v] of Object.entries(vars)) {
      if (v === null) continue
      argv.push(typeof v === 'string' ? '-f' : '-F', `${k}=${v}`)
    }
    const r = await io.run(argv, { timeoutMs: 60000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}`)
    return parse(r.stdout)
  }
  const r = await io.fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${access.token}`,
      'content-type': 'application/json',
      'user-agent': 'shipwatch',
    },
    body: JSON.stringify({ query, variables: vars }),
  })
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
  return parse(r.text)
}

const rest = async (io: IO, access: Access, path: string) => {
  if (access.source === 'gh') {
    const r = await io.run(['gh', 'api', path], { timeoutMs: 30000 })
    if (r.exitCode !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `gh exited ${r.exitCode}`)
    return parse(r.stdout)
  }
  const r = await io.fetch(`https://api.github.com/${path}`, {
    headers: {
      authorization: `Bearer ${access.token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'shipwatch',
    },
  })
  if (!r.ok) throw new Error(`GitHub answered ${r.status}`)
  return parse(r.text)
}

export const resolveOwner = async (io: IO, access: Access, owner: string): Promise<string> => {
  if (owner) return owner
  const out = await graphql(io, access, VIEWER, {})
  const login = out?.data?.viewer?.login
  if (!login) throw new Error('Could not tell which GitHub account is signed in; set the owner option.')
  return login
}

export const fetchRepos = async (
  io: IO,
  access: Access,
  owner: string,
  count: number,
  includeForks: boolean,
): Promise<RawRepo[]> => {
  const out = await graphql(io, access, QUERY, {
    owner,
    n: count,
    fork: includeForks ? null : false,
  })
  if (out?.errors?.length && !out?.data?.repositoryOwner) {
    throw new Error(out.errors[0].message ?? 'GitHub query failed')
  }
  const nodes: RawRepo[] | undefined = out?.data?.repositoryOwner?.repositories?.nodes
  if (!nodes) throw new Error(`No repositories found for ${owner}`)
  return nodes.filter(Boolean)
}

/** Names of the workflow runs in flight on a repo, as `workflow · branch`. */
export const fetchActivity = async (io: IO, access: Access, owner: string, repo: string): Promise<string[]> => {
  const out = await rest(io, access, `repos/${owner}/${repo}/actions/runs?per_page=10`)
  const runs: Array<{ name?: string; head_branch?: string; status?: string }> = out?.workflow_runs ?? []
  return runs
    .filter(r => r.status === 'in_progress' || r.status === 'queued' || r.status === 'pending')
    .map(r => `${r.name ?? 'workflow'} · ${r.head_branch ?? '?'}`)
}

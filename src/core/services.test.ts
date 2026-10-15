import { expect, test } from 'claude-code/testing'

import { buildBoard } from './boardService'
import type { InfraVerdicts } from './boardService'
import type { Access, IO, Store } from './ports'
import { STATS_FRESH_MS, loadStatsCache, refreshStats, statsAreFresh } from './statsService'
import type { StatsBoard } from './types'

// A stand-in for GitHub: answers `gh` calls from canned data, and records what was asked.
type Ask = { kind: 'graphql' | 'rest'; text: string; vars: Record<string, string> }

const fakeGitHub = (answer: (ask: Ask) => unknown) => {
  const asked: Ask[] = []
  const io: IO = {
    run: async argv => {
      if (argv[1] === 'auth') return { exitCode: 0, stdout: '', stderr: '' }
      const vars: Record<string, string> = {}
      let text = ''
      for (let i = 2; i < argv.length; i++) {
        const flag = argv[i]!
        if (flag === '-f' || flag === '-F') {
          const [k, ...rest] = argv[++i]!.split('=')
          if (k === 'query') text = rest.join('=')
          else vars[k!] = rest.join('=')
        } else if (!flag.startsWith('-') && flag !== 'graphql') text = flag
      }
      const ask: Ask = { kind: argv[2] === 'graphql' ? 'graphql' : 'rest', text, vars }
      asked.push(ask)
      return { exitCode: 0, stdout: JSON.stringify(answer(ask)), stderr: '' }
    },
    fetch: async () => {
      throw new Error('no HTTP in this test')
    },
  }
  return { io, asked }
}

const ACCESS: Access = { source: 'gh', token: '' }
const NOW = Date.parse('2026-10-09T12:00:00Z')
const DAY = 86_400_000

const memoryStore = (): Store & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>()
  return { data, get: async k => data.get(k), set: async (k, v) => void data.set(k, JSON.parse(JSON.stringify(v))) }
}

const commit = (over: Record<string, unknown>) => ({
  message: 'work',
  additions: 10,
  deletions: 1,
  parents: { totalCount: 1 },
  author: { name: 'K', email: 'k@example.com', user: { login: 'me' } },
  authors: { nodes: [] },
  ...over,
})

const pr = (id: string, repo: string, mergedAt: string, commits: Array<Record<string, unknown>>) => ({
  id,
  mergedAt,
  repository: { name: repo },
  commits: { nodes: commits.map(c => ({ commit: c })) },
})

const search = (nodes: unknown[]) => ({ data: { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } } })

const emptyStats = (over: Partial<StatsBoard> = {}): StatsBoard => ({
  range: 30,
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
  ...over,
})

const statsAnswer = (ask: Ask): unknown => {
  if (ask.text.includes('viewer')) return { data: { viewer: { login: 'me' } } }
  if (ask.text.includes('repositoryOwner') && ask.text.includes('CREATED_AT')) {
    return {
      data: {
        repositoryOwner: {
          repositories: {
            pageInfo: { hasNextPage: false },
            nodes: [{ name: 'fresh', createdAt: '2026-10-01T00:00:00Z', isArchived: false, isFork: false }],
          },
        },
      },
    }
  }
  // Only the first window (9 Sep to 8 Oct, which holds both PRs) has any.
  if (ask.vars.q?.includes('merged:2026-09-09..2026-10-08')) {
    return search([
      pr('a', 'app', '2026-10-01T10:00:00Z', [commit({ message: 'x\n\nCo-Authored-By: Claude <noreply@anthropic.com>', additions: 100, deletions: 10 })]),
      pr('b', 'app', '2026-10-02T10:00:00Z', [commit({})]),
    ])
  }
  return search([])
}

test('refreshStats loads the range, attributes each commit, keeps the result, and asks only for what is new next time', async () => {
  const gh = fakeGitHub(statsAnswer)
  const store = memoryStore()
  const progress: string[] = []
  const first = await refreshStats(
    { io: gh.io, access: ACCESS, store, owner: 'me', aiNames: [], now: NOW, onProgress: t => progress.push(t) },
    emptyStats(),
  )
  expect(first.you).toBe('me')
  expect(first.prs.map(p => p.id).sort()).toEqual(['a', 'b'])
  expect(first.prs.find(p => p.id === 'a')!.by).toEqual({ Claude: [1, 100, 10] })
  expect(first.prs.find(p => p.id === 'b')!.by).toEqual({ You: [1, 10, 1] })
  expect(first.repos.map(r => r.name)).toEqual(['fresh'])
  expect(first.coveredThrough).toBe('2026-10-08')
  expect(progress.some(t => t.startsWith('Loading merged PRs'))).toBe(true)

  // Another session: the saved history comes back, and only today is asked for.
  const saved = await loadStatsCache(store, 'me', [])
  expect(saved?.prs.length).toBe(2)
  const second = fakeGitHub(statsAnswer)
  await refreshStats(
    { io: second.io, access: ACCESS, store, owner: 'me', aiNames: [], now: NOW },
    emptyStats({ ...saved!, range: 30 }),
  )
  const windows = second.asked.map(a => a.vars.q).filter((q): q is string => !!q)
  expect(windows).toEqual(['user:me is:pr is:merged merged:2026-10-09..2026-10-09'])
})

test('a saved history made under other rules is not trusted', async () => {
  const gh = fakeGitHub(statsAnswer)
  const store = memoryStore()
  await refreshStats({ io: gh.io, access: ACCESS, store, owner: 'me', aiNames: [], now: NOW }, emptyStats())
  expect(await loadStatsCache(store, 'me', [])).not.toBeNull()
  expect(await loadStatsCache(store, 'me', ['Zed'])).toBeNull() // the AI names changed
  expect(await loadStatsCache(store, 'someone-else', [])).toBeNull()
  expect(await loadStatsCache(memoryStore(), 'me', [])).toBeNull()
})

test('statsAreFresh: recent and covering the range', () => {
  const base = { updatedAt: NOW - 60_000, coveredFrom: '2026-09-01', range: 30 as const }
  expect(statsAreFresh(base, NOW)).toBe(true)
  expect(statsAreFresh({ ...base, updatedAt: NOW - STATS_FRESH_MS - 1 }, NOW)).toBe(false)
  expect(statsAreFresh({ ...base, range: 365 }, NOW)).toBe(false) // wants older days than are held
  expect(statsAreFresh({ ...base, updatedAt: 0 }, NOW)).toBe(false)
  expect(statsAreFresh({ ...base, coveredFrom: '' }, NOW)).toBe(false)
})

const rollup = (state: string, ...nodes: Array<{ status?: string; conclusion?: string }>) => ({ state, contexts: { nodes } })

const repoNode = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  url: `https://github.com/me/${name}`,
  isArchived: false,
  isFork: false,
  pushedAt: new Date(NOW - 3_600_000).toISOString(),
  defaultBranchRef: {
    name: 'main',
    target: { oid: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', committedDate: new Date(NOW - 7_200_000).toISOString(), statusCheckRollup: rollup('SUCCESS', { status: 'COMPLETED', conclusion: 'SUCCESS' }) },
  },
  latestRelease: null,
  pullRequests: { nodes: [] },
  ...over,
})

test('buildBoard orders repos by urgency, reads cancelled runs as no result, and names the runs in flight', async () => {
  const building = repoNode('building', {
    defaultBranchRef: {
      name: 'main',
      target: { oid: 'b'.repeat(40), committedDate: new Date(NOW - 60_000).toISOString(), statusCheckRollup: rollup('PENDING', { status: 'IN_PROGRESS' }) },
    },
  })
  const cancelledOnly = repoNode('cancelled', {
    defaultBranchRef: {
      name: 'main',
      target: { oid: 'c'.repeat(40), committedDate: new Date(NOW - 60_000).toISOString(), statusCheckRollup: rollup('FAILURE', { status: 'COMPLETED', conclusion: 'CANCELLED' }) },
    },
  })
  const gh = fakeGitHub(ask => {
    if (ask.kind === 'graphql') return { data: { repositoryOwner: { repositories: { nodes: [repoNode('quiet'), cancelledOnly, building] } } } }
    return { workflow_runs: [{ name: 'Auto Release', head_branch: 'main', status: 'in_progress', html_url: 'https://github.com/me/building/actions/runs/1' }] }
  })
  const verdicts: InfraVerdicts = new Map()
  const repos = await buildBoard(
    gh.io,
    ACCESS,
    { owner: 'me', count: 40, includeForks: false, ignore: new Set(['ignored']), staleMs: 14 * DAY },
    NOW,
    verdicts,
  )
  expect(repos.map(r => r.name)).toEqual(['building', 'quiet', 'cancelled'].filter(n => repos.some(r => r.name === n)))
  expect(repos[0]!.level).toBe('running')
  expect(repos[0]!.activity).toEqual([{ text: 'Auto Release · main', url: 'https://github.com/me/building/actions/runs/1' }])
  // Cancelled-only is not a failure: no infra lookup, and it is not marked failing.
  expect(repos.find(r => r.name === 'cancelled')!.level).not.toBe('fail')
  expect(verdicts.size).toBe(0)
})

test('buildBoard leaves out archived and ignored repos', async () => {
  const gh = fakeGitHub(() => ({
    data: { repositoryOwner: { repositories: { nodes: [repoNode('keep'), repoNode('old', { isArchived: true }), repoNode('Skip')] } } },
  }))
  const repos = await buildBoard(gh.io, ACCESS, { owner: 'me', count: 40, includeForks: false, ignore: new Set(['skip']), staleMs: 14 * DAY }, NOW, new Map())
  expect(repos.map(r => r.name)).toEqual(['keep'])
})

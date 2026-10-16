import { expect, test } from 'claude-code/testing'

import { buildBoard } from './boardService'
import type { InfraVerdicts } from './boardService'
import { fetchGraphqlReset } from './github'
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

test('a long load keeps what it has fetched, newest first, when GitHub stops it part way', async () => {
  const store = memoryStore()
  const rateLimited = (ask: Ask): unknown => {
    if (ask.text.includes('viewer')) return { data: { viewer: { login: 'me' } } }
    if (ask.text.includes('CREATED_AT')) return { data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false }, nodes: [] } } } }
    if (ask.vars.q?.includes('merged:2026-10-09..')) return search([]) // today, still empty
    if (ask.vars.q?.includes('merged:2026-09-09..')) return search([pr('new', 'app', '2026-10-01T10:00:00Z', [commit({})])])
    throw new Error('gh: API rate limit already exceeded for user ID 1.')
  }
  const gh = fakeGitHub(rateLimited)
  let failure = ''
  try {
    await refreshStats({ io: gh.io, access: ACCESS, store, owner: 'me', aiNames: [], now: NOW }, emptyStats({ range: 90 }))
  } catch (err) {
    failure = String(err)
  }
  expect(failure).toContain('rate limit')
  // The newest windows were asked for first and kept: one unbroken stretch from there to yesterday.
  const windows = gh.asked.map(a => a.vars.q).filter(Boolean)
  expect(windows[0]).toContain('merged:2026-10-09..')
  expect(windows[1]).toContain('merged:2026-09-09..')
  const kept = await loadStatsCache(store, 'me', [])
  expect(kept?.prs.map(p => p.id)).toEqual(['new'])
  expect(kept?.coveredFrom).toBe('2026-09-09')
  expect(kept?.coveredThrough).toBe('2026-10-08')

  // The next run, told how to wait, rides out the limit once and then fills in the older windows only.
  let limited = true
  const second = fakeGitHub(ask => {
    if (limited && ask.vars.q?.includes('merged:2026-08-10..')) {
      limited = false
      throw new Error('gh: API rate limit already exceeded for user ID 1.')
    }
    if (ask.vars.q?.includes('merged:2026-08-10..2026-09-08')) return search([pr('old', 'app', '2026-08-20T10:00:00Z', [commit({})])])
    return ask.vars.q ? search([]) : rateLimited(ask)
  })
  const waits: number[] = []
  const done = await refreshStats(
    { io: second.io, access: ACCESS, store, owner: 'me', aiNames: [], now: NOW, wait: async ms => void waits.push(ms) },
    emptyStats({ ...kept!, range: 90 }),
  )
  expect(waits).toEqual([60_000])
  expect(done.prs.map(p => p.id).sort()).toEqual(['new', 'old'])
  expect(done.coveredFrom).toBe('2026-07-11')
})

test('the board read reports what is left of GitHub\'s allowance, and the reset time is asked of the free endpoint', async () => {
  const gh = fakeGitHub(ask => {
    if (ask.kind === 'rest' && ask.text === 'rate_limit') return { resources: { graphql: { remaining: 4_321, limit: 5_000, reset: 1_792_100_964 } } }
    return {
      data: {
        rateLimit: { cost: 9, remaining: 4_321, limit: 5_000, resetAt: '2026-10-15T21:49:24Z' },
        repositoryOwner: { repositories: { nodes: [] } },
      },
    }
  })
  let seen: unknown
  await buildBoard(gh.io, ACCESS, { owner: 'me', count: 10, includeForks: false, ignore: new Set(), staleMs: 1, onBudget: b => void (seen = b) }, NOW, new Map())
  expect(seen).toEqual({ cost: 9, remaining: 4_321, limit: 5_000, resetAt: Date.parse('2026-10-15T21:49:24Z') })
  expect(await fetchGraphqlReset(gh.io, ACCESS)).toBe(1_792_100_964_000)
  expect(await fetchGraphqlReset(fakeGitHub(() => ({})).io, ACCESS)).toBeUndefined()
})

test('a load that hits the hourly limit waits for the reset when it is soon, and stops with an explanation when it is not', async () => {
  const limited = (resetInMs: number) => (ask: Ask): unknown => {
    if (ask.kind === 'rest' && ask.text === 'rate_limit') return { resources: { graphql: { remaining: 0, limit: 5_000, reset: Math.floor((Date.now() + resetInMs) / 1000) } } }
    if (ask.text.includes('viewer')) return { data: { viewer: { login: 'me' } } }
    if (ask.text.includes('CREATED_AT')) return { data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false }, nodes: [] } } } }
    if (ask.vars.q) throw new Error('gh: API rate limit already exceeded for user ID 1.')
    return {}
  }
  // Soon: it waits roughly until the reset, once, then goes on (the retry fails again here, so it ends after one wait).
  const waits: number[] = []
  let soonFailure = ''
  try {
    await refreshStats(
      { io: fakeGitHub(limited(3 * 60_000)).io, access: ACCESS, store: memoryStore(), owner: 'me', aiNames: [], now: NOW, wait: async ms => void waits.push(ms) },
      emptyStats(),
    )
  } catch (err) {
    soonFailure = String(err)
  }
  expect(waits.length).toBeGreaterThan(0)
  expect(waits[0]! > 3 * 60_000 - 5_000 && waits[0]! < 3 * 60_000 + 10_000).toBe(true)
  expect(soonFailure).toContain('rate-limit error') // it gave up after a few waits, and says what GitHub reports
  expect(soonFailure).toContain('0 of 5,000 points left and a reset at')
  expect(soonFailure).toContain('Choose Refresh')

  // Far off (an hour): no waiting; it stops and says when the allowance returns.
  const far: number[] = []
  let farFailure = ''
  try {
    await refreshStats(
      { io: fakeGitHub(limited(60 * 60_000)).io, access: ACCESS, store: memoryStore(), owner: 'me', aiNames: [], now: NOW, wait: async ms => void far.push(ms) },
      emptyStats(),
    )
  } catch (err) {
    farFailure = String(err)
  }
  expect(far).toEqual([])
  expect(farFailure).toContain('rate-limit error')
  expect(farFailure).toContain('a reset at')
})

const quiet = (extra: (ask: Ask) => unknown | undefined) => (ask: Ask): unknown => {
  if (ask.text.includes('viewer')) return { data: { viewer: { login: 'me' } } }
  if (ask.text.includes('CREATED_AT')) return { data: { repositoryOwner: { repositories: { pageInfo: { hasNextPage: false }, nodes: [] } } } }
  return extra(ask) ?? search([])
}
const withBudget = (r: unknown, budget: unknown): unknown => ({ data: { ...(r as { data: object }).data, rateLimit: budget } })

test('a refusal is waited out until the reset time GitHub reports, even with points left, and then the load goes on', async () => {
  let refused = false
  const gh = fakeGitHub(
    quiet(ask => {
      if (ask.kind === 'rest' && ask.text === 'rate_limit') return { resources: { graphql: { remaining: 4_200, limit: 5_000, reset: Math.floor(Date.now() / 1000) + 180 } } }
      if (ask.vars.q && !refused) {
        refused = true
        throw new Error('gh: API rate limit already exceeded for user ID 1.')
      }
      return undefined
    }),
  )
  const waits: number[] = []
  const said: string[] = []
  const done = await refreshStats(
    { io: gh.io, access: ACCESS, store: memoryStore(), owner: 'me', aiNames: [], now: NOW, wait: async ms => void waits.push(ms), onProgress: t => said.push(t) },
    emptyStats({ range: 90 }),
  )
  expect(waits.length).toBe(1)
  expect(waits[0]! > 180_000 - 2_000 && waits[0]! < 180_000 + 10_000).toBe(true) // until the reset it reported, not a time of its own
  expect(said.some(t => t.includes('4,200 of 5,000 points left') && t.includes('Shipwatch will try again then'))).toBe(true)
  for (const guess of ['briefly', 'burst', '90 s']) expect(said.some(t => t.includes(guess))).toBe(false)
  expect(done.coveredFrom).toBe('2026-07-11')
})

test('the history load spaces its requests by what each cost, so a long load does not trip the burst limit', async () => {
  const gh = fakeGitHub(quiet(ask => (ask.vars.q ? withBudget(search([]), { cost: 40, remaining: 4_000, limit: 5_000, resetAt: '2026-10-09T13:00:00Z' }) : undefined)))
  const waits: number[] = []
  await refreshStats({ io: gh.io, access: ACCESS, store: memoryStore(), owner: 'me', aiNames: [], now: NOW, wait: async ms => void waits.push(ms) }, emptyStats({ range: 90 }))
  expect(waits).toEqual([2_000, 2_000, 2_000]) // 40 points at 50 ms each, between the four windows
})

test('the load stops to leave the reserve alone, waiting for a reset that is soon and giving up on one that is far', async () => {
  const answer = (resetInMs: number) =>
    quiet(ask => (ask.vars.q ? withBudget(search([]), { cost: 40, remaining: 1_400, limit: 5_000, resetAt: new Date(Date.now() + resetInMs).toISOString() }) : undefined))
  // Far: stops, and says when to come back.
  let failure = ''
  try {
    await refreshStats({ io: fakeGitHub(answer(60 * 60_000)).io, access: ACCESS, store: memoryStore(), owner: 'me', aiNames: [], now: NOW, wait: async () => {} }, emptyStats({ range: 90 }))
  } catch (err) {
    failure = String(err)
  }
  expect(failure).toContain('keep part of GitHub')
  expect(failure).toContain('resets at')
  // Soon: waits for it (after the usual gap), then goes on.
  const waits: number[] = []
  await refreshStats({ io: fakeGitHub(answer(3 * 60_000)).io, access: ACCESS, store: memoryStore(), owner: 'me', aiNames: [], now: NOW, wait: async ms => void waits.push(ms) }, emptyStats({ range: 90 }))
  expect(waits[0]).toBe(2_000)
  expect(waits[1]! > 3 * 60_000 && waits[1]! < 3 * 60_000 + 10_000).toBe(true)
  // Asked to spend the reserve: it does not stop or wait at all while there is allowance for the next request.
  const spendWaits: number[] = []
  await refreshStats({ io: fakeGitHub(answer(60 * 60_000)).io, access: ACCESS, store: memoryStore(), owner: 'me', aiNames: [], now: NOW, wait: async ms => void spendWaits.push(ms), spendReserve: true }, emptyStats({ range: 90 }))
  expect(spendWaits.every(ms => ms <= 8_000)).toBe(true)
})

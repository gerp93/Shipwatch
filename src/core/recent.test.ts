import { expect, test } from 'claude-code/testing'

import type { Access, IO } from './ports'
import { fetchRecentPrs } from './recent'

const ACCESS: Access = { source: 'gh', token: '' }

/** A stand-in for `gh`: records the arguments and answers with `reply`. */
const fakeIO = (reply: unknown): { io: IO; calls: string[][] } => {
  const calls: string[][] = []
  const io: IO = {
    run: async argv => {
      calls.push(argv)
      return { exitCode: 0, stdout: JSON.stringify(reply), stderr: '' }
    },
    fetch: async () => {
      throw new Error('no HTTP in this test')
    },
  }
  return { io, calls }
}

const node = (over: Record<string, unknown>) => ({
  number: 1,
  title: 'A change',
  url: 'https://github.com/o/app/pull/1',
  createdAt: '2026-10-15T14:00:00Z',
  mergedAt: null,
  isDraft: false,
  state: 'OPEN',
  repository: { name: 'app' },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...over,
})

test('recent PRs are read with their state and checks, newest first, from the time asked for', async () => {
  const { io, calls } = fakeIO({
    data: {
      rateLimit: { cost: 1, remaining: 4_999, limit: 5_000, resetAt: '2026-10-15T15:00:00Z' },
      search: {
        nodes: [
          node({ number: 1, createdAt: '2026-10-15T14:00:00Z' }),
          node({ number: 2, createdAt: '2026-10-15T14:20:00Z', state: 'MERGED', mergedAt: '2026-10-15T14:25:00Z' }),
          node({ number: 3, createdAt: '2026-10-15T14:10:00Z', state: 'CLOSED' }),
          node({ number: 4, createdAt: '2026-10-15T14:05:00Z', isDraft: true }),
          node({ number: 5, createdAt: '2026-10-15T14:15:00Z', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] } }),
          node({ number: 6, createdAt: '2026-10-15T14:12:00Z', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } }),
          node({ number: 7, createdAt: '2026-10-15T14:11:00Z', commits: { nodes: [{ commit: { statusCheckRollup: null } }] } }),
          null, // GitHub can return an empty node for an inaccessible one
          { notAPr: true },
        ],
      },
    },
  })
  let budget: unknown
  const since = Date.parse('2026-10-15T13:30:15.250Z')
  const prs = await fetchRecentPrs(io, ACCESS, 'me', since, b => void (budget = b))

  expect(prs.map(p => p.number)).toEqual([2, 5, 6, 7, 3, 4, 1]) // by when each was opened, newest first
  const by = Object.fromEntries(prs.map(p => [p.number, p]))
  expect(by[1]).toMatchObject({ repo: 'app', state: 'open', checks: 'passing', isDraft: false, mergedAt: null })
  expect(by[2]).toMatchObject({ state: 'merged', mergedAt: '2026-10-15T14:25:00Z', checks: 'none' }) // checks only matter while open
  expect(by[3]).toMatchObject({ state: 'closed', checks: 'none' })
  expect(by[4]!.isDraft).toBe(true)
  expect(by[5]!.checks).toBe('failing')
  expect(by[6]!.checks).toBe('running')
  expect(by[7]!.checks).toBe('none')
  expect(budget).toEqual({ cost: 1, remaining: 4_999, limit: 5_000, resetAt: Date.parse('2026-10-15T15:00:00Z') })

  // One search, for the account's PRs created since the time asked for, to the second and in UTC.
  expect(calls.length).toBe(1)
  expect(calls[0]!.join(' ')).toContain('q=user:me is:pr created:>=2026-10-15T13:30:15Z')
})

test('an answer with no search results is an error, not an empty hour', async () => {
  let failure = ''
  try {
    await fetchRecentPrs(fakeIO({ errors: [{ message: 'Something went wrong' }] }).io, ACCESS, 'me', 0)
  } catch (err) {
    failure = String(err)
  }
  expect(failure).toContain('Something went wrong')
  expect(await fetchRecentPrs(fakeIO({ data: { search: { nodes: [] } } }).io, ACCESS, 'me', 0)).toEqual([])
})

import { expect, test } from 'claude-code/testing'

import type { PrSummary } from './types'
import {
  ALL_AI,
  ALL_TIME,
  MIXED,
  OTHERS,
  YOU,
  actorOf,
  aggregate,
  aiFamilyOf,
  actorLabel,
  aisIn,
  barCells,
  bucketFor,
  commitSeries,
  compact,
  earliestKnown,
  hiddenInView,
  humansIn,
  isAi,
  rangeLabel,
  rangeSince,
  reposCreatedSince,
  summarizePr,
  trailersOf,
  weekStart,
} from './stats'
import type { RawCommit } from './stats'

const ME = 'gerp93'
const commit = (over: Record<string, unknown> = {}): RawCommit => ({
  message: 'Add a thing',
  additions: 10,
  deletions: 2,
  parents: { totalCount: 1 },
  author: { name: 'K', email: 'k@example.com', user: { login: ME } },
  authors: { nodes: [] },
  ...over,
}) as RawCommit

test('a commit is attributed by author identity or by a Co-Authored-By trailer', () => {
  expect(actorOf(commit(), ME)).toBe(YOU)
  expect(actorOf(commit({ author: { name: 'claude', user: { login: 'claude' } } }), ME)).toBe('Claude')
  expect(actorOf(commit({ message: 'x\n\nCo-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>' }), ME)).toBe('Claude')
  expect(actorOf(commit({ author: { name: 'Cursor Agent', user: { login: 'cursoragent' } } }), ME)).toBe('Cursor')
  expect(actorOf(commit({ author: { name: 'Copilot', user: { login: 'Copilot' } } }), ME)).toBe('Copilot')
  // GitHub also lists co-authors itself.
  expect(actorOf(commit({ authors: { nodes: [{ name: 'Claude', email: 'noreply@anthropic.com' }] } }), ME)).toBe('Claude')
})

test('people who are not you, and automation, are neither You nor AI', () => {
  expect(actorOf(commit({ author: { name: 'Grant', user: { login: 'GrantFBarnes' } } }), ME)).toBe('@GrantFBarnes')
  expect(actorOf(commit({ author: { name: 'Grant Barnes', user: null } }), ME)).toBe('@Grant Barnes')
  expect(actorOf(commit({ author: null }), ME)).toBe(OTHERS)
  expect(actorOf(commit({ author: { name: 'dependabot[bot]', user: { login: 'dependabot[bot]' } } }), ME)).toBe('Automation')
})

test('an unknown bot account is named by its own login, and the aiNames option adds more', () => {
  expect(aiFamilyOf({ name: 'shiny-agent[bot]', user: { login: 'shiny-agent[bot]' } })).toBe('Shiny-Agent')
  expect(aiFamilyOf({ name: 'Zed Agent', email: 'agent@zed.dev' }, ['zed agent'])).toBe('Zed Agent')
  expect(aiFamilyOf({ name: 'Ordinary Person', user: { login: 'person' } })).toBeUndefined()
  // A person whose name merely contains a family's letters is not an AI.
  expect(aiFamilyOf({ name: 'Claudette', user: { login: 'claudette' } })).toBeUndefined()
})

test('trailers are read from any line, any case', () => {
  const found = trailersOf('Fix\n\nco-authored-by: A B <a@b.c>\nCo-Authored-By: Claude <noreply@anthropic.com>')
  expect(found.map(t => t.name)).toEqual(['A B', 'Claude'])
})

const raw = (id: string, mergedAt: string, repo: string, commits: Array<Record<string, unknown>>) => ({
  id,
  mergedAt,
  repository: { name: repo },
  commits: { nodes: commits.map(c => ({ commit: c })) },
})

test('summarizePr counts non-merge commits and lines per actor', () => {
  const s = summarizePr(
    raw('1', '2026-10-01T00:00:00Z', 'app', [
      commit({ message: 'a\n\nCo-Authored-By: Claude <noreply@anthropic.com>', additions: 100, deletions: 20 }),
      commit({ additions: 5, deletions: 1 }),
      commit({ parents: { totalCount: 2 }, additions: 999 }),
    ]),
    ME,
  )
  expect(s.by).toEqual({ Claude: [1, 100, 20], [YOU]: [1, 5, 1] })
})

const pr = (id: string, mergedAt: string, repo: string, by: PrSummary['by']): PrSummary => ({ id, mergedAt, repo, by })
const NOW = Date.parse('2026-10-09T00:00:00Z')
const DAY = 86_400_000
const PRS = [
  pr('a', '2026-10-08T10:00:00Z', 'x', { Claude: [3, 300, 30] }),
  pr('b', '2026-10-07T10:00:00Z', 'x', { [YOU]: [2, 40, 4] }),
  pr('c', '2026-10-06T10:00:00Z', 'y', { Cursor: [1, 10, 1] }),
  pr('d', '2026-10-05T10:00:00Z', 'y', { [YOU]: [1, 5, 1], Claude: [2, 50, 5] }),
  pr('e', '2026-08-01T10:00:00Z', 'x', { Claude: [1, 1, 1] }),
]

test('combined mode compares You with all AI together, and counts a mixed PR once', () => {
  const a = aggregate(PRS, NOW - 30 * DAY, 'combined')
  expect(a.prs).toBe(4)
  expect(a.mixed).toBe(1)
  const you = a.actors.find(x => x.actor === YOU)!
  const ai = a.actors.find(x => x.actor === ALL_AI)!
  expect(you).toMatchObject({ prs: 1, commits: 3, adds: 45, dels: 5 })
  expect(ai).toMatchObject({ prs: 2, commits: 6, adds: 360, dels: 36 })
  expect(a.actors.map(x => x.actor)).toEqual([YOU, ALL_AI])
})

test('separate mode keeps each AI apart', () => {
  const a = aggregate(PRS, NOW - 30 * DAY, 'separate')
  expect(a.actors.map(x => x.actor)).toEqual([YOU, 'Claude', 'Cursor'])
  expect(a.actors.find(x => x.actor === 'Cursor')).toMatchObject({ prs: 1, commits: 1 })
})

test('switching an AI off compares You with only the rest, and drops PRs that were only that AI', () => {
  const a = aggregate(PRS, NOW - 30 * DAY, 'separate', ['Claude'])
  expect(a.prs).toBe(3)
  expect(a.actors.map(x => x.actor)).toEqual([YOU, 'Cursor'])
  // The mixed PR keeps its human commit; its Claude commits are not shown.
  expect(a.actors.find(x => x.actor === YOU)).toMatchObject({ prs: 2, commits: 3 })
})

test('the range cuts off older PRs, and repos and weeks are totalled', () => {
  const week = aggregate(PRS, NOW - 7 * DAY, 'combined')
  expect(week.prs).toBe(4) // a, b, c and d; e was merged in August
  const three = aggregate(PRS, NOW - 3 * DAY, 'combined')
  expect(three.prs).toBe(3) // a, b and c (6 Oct 10:00 is inside 3 days of 9 Oct 00:00)
  const all = aggregate(PRS, NOW - 365 * DAY, 'combined')
  expect(all.prs).toBe(5)
  expect(all.repos.map(r => [r.repo, r.prs])).toEqual([['x', 3], ['y', 2]])
  expect(all.weeks.reduce((n, w) => n + Object.values(w.prs).reduce((a, b) => a + b, 0), 0)).toBe(5)
})

test('weeks start on Monday (UTC)', () => {
  expect(weekStart('2026-10-09T12:00:00Z')).toBe('2026-10-05') // a Friday
  expect(weekStart('2026-10-05T00:00:00Z')).toBe('2026-10-05')
  expect(weekStart('2026-10-11T23:59:00Z')).toBe('2026-10-05') // the Sunday
})

test('aisIn lists every AI that appears, busiest first', () => {
  expect(aisIn(PRS)).toEqual(['Claude', 'Cursor'])
})

test('repos created: archived ones count, forks do not unless asked for', () => {
  const repos = [
    { name: 'new', createdAt: '2026-10-01T00:00:00Z', isArchived: false, isFork: false },
    { name: 'retired', createdAt: '2026-09-20T00:00:00Z', isArchived: true, isFork: false },
    { name: 'forked', createdAt: '2026-09-25T00:00:00Z', isArchived: false, isFork: true },
    { name: 'old', createdAt: '2025-01-01T00:00:00Z', isArchived: false, isFork: false },
  ]
  expect(reposCreatedSince(repos, NOW - 30 * DAY).map(r => r.name)).toEqual(['new', 'retired'])
  expect(reposCreatedSince(repos, NOW - 30 * DAY, true).map(r => r.name)).toEqual(['new', 'forked', 'retired'])
})

test('barCells fills the width exactly and keeps small parts visible', () => {
  expect(barCells([1, 1], 10)).toEqual([5, 5])
  const cells = barCells([950, 10, 40], 20)
  expect(cells.reduce((a, b) => a + b, 0)).toBe(20)
  expect(cells.every(c => c >= 1)).toBe(true)
  expect(barCells([0, 0], 10)).toEqual([0, 0])
  expect(barCells([5, 0, 5], 4)).toEqual([2, 0, 2])
})

test('compact numbers', () => {
  expect(compact(999)).toBe('999')
  expect(compact(1234)).toBe('1,234')
  expect(compact(51200)).toBe('51.2k')
  expect(compact(1_500_000)).toBe('1.5M')
  expect(compact(MIXED.length)).toBe('5')
})

import { dateOf, mergeById, planFetch, windowsBetween } from './stats'

test('windowsBetween splits a span into month-sized inclusive date windows with no gaps', () => {
  const w = windowsBetween(Date.parse('2026-08-01T05:00:00Z'), Date.parse('2026-10-09T12:00:00Z'))
  expect(w[0]).toEqual({ from: '2026-08-01', to: '2026-08-30' })
  expect(w[1]).toEqual({ from: '2026-08-31', to: '2026-09-29' })
  expect(w[2]).toEqual({ from: '2026-09-30', to: '2026-10-09' })
  expect(windowsBetween(Date.parse('2026-10-09T00:00:00Z'), Date.parse('2026-10-09T23:00:00Z'))).toEqual([{ from: '2026-10-09', to: '2026-10-09' }])
  expect(dateOf(Date.parse('2026-10-09T23:59:00Z'))).toBe('2026-10-09')
})

test('planFetch fetches everything the first time, then only what is new or older', () => {
  const now = Date.parse('2026-10-09T12:00:00Z')
  const first = planFetch('', '', now, now - 30 * DAY)
  expect(first.windows).toEqual([{ from: '2026-09-09', to: '2026-10-08' }, { from: '2026-10-09', to: '2026-10-09' }])
  expect(first.coveredFrom).toBe('2026-09-09')
  expect(first.coveredThrough).toBe('2026-10-08')

  // A later refresh: only today (it was still filling) needs fetching again.
  const again = planFetch(first.coveredFrom, first.coveredThrough, now, now - 30 * DAY)
  expect(again.windows).toEqual([{ from: '2026-10-09', to: '2026-10-09' }])

  // A wider range also asks for the days before what is held.
  const wider = planFetch(first.coveredFrom, first.coveredThrough, now, now - 90 * DAY)
  expect(wider.windows[0]).toEqual({ from: '2026-07-11', to: '2026-08-09' })
  expect(wider.windows.at(-1)).toEqual({ from: '2026-10-09', to: '2026-10-09' })
  expect(wider.coveredFrom).toBe('2026-07-11')

  // A day later, yesterday's tail and today are fetched.
  const nextDay = planFetch(first.coveredFrom, first.coveredThrough, now + DAY, now + DAY - 30 * DAY)
  expect(nextDay.windows).toEqual([{ from: '2026-10-09', to: '2026-10-10' }])
})

test('mergeById keeps one copy of each PR, preferring the newer', () => {
  const merged = mergeById([pr('a', '2026-10-01T00:00:00Z', 'x', { [YOU]: [1, 1, 1] })], [pr('a', '2026-10-01T00:00:00Z', 'x', { Claude: [1, 1, 1] }), pr('b', '2026-10-02T00:00:00Z', 'x', {})])
  expect(merged.map(p => p.id)).toEqual(['a', 'b'])
  expect(merged[0]!.by).toEqual({ Claude: [1, 1, 1] })
})

test('range buttons say how far back they reach, and all time starts at the oldest thing known', () => {
  expect(rangeLabel(180)).toBe('180 days')
  expect(rangeLabel(365)).toBe('365 days')
  expect(rangeLabel(730)).toBe('2 years')
  expect(rangeLabel(1825)).toBe('5 years')
  expect(rangeLabel(ALL_TIME)).toBe('All time')
  const now = Date.parse('2026-10-15T12:00:00Z')
  const oldest = Date.parse('2022-03-01T00:00:00Z')
  expect(rangeSince(ALL_TIME, now, oldest)).toBe(oldest)
  expect(rangeSince(180, now, oldest)).toBe(now - 180 * 86_400_000)
  // With nothing known yet, all time falls back to a year rather than to 1970.
  expect(rangeSince(ALL_TIME, now, undefined)).toBe(now - 365 * 86_400_000)
  expect(earliestKnown([{ name: 'a', createdAt: '2023-05-01T00:00:00Z', isArchived: false, isFork: false }], [pr('p', '2022-03-01T00:00:00Z', 'a', {})])).toBe(oldest)
  expect(earliestKnown([], [])).toBeUndefined()
})

test('humans are shown as humans: the stored Others key, and each person by their login', () => {
  expect(actorLabel(OTHERS)).toBe('Other humans')
  expect(actorLabel('@GrantFBarnes')).toBe('GrantFBarnes')
  expect(isAi('@GrantFBarnes')).toBe(false)
  expect(actorLabel(YOU)).toBe('You')
  expect(actorLabel('Claude')).toBe('Claude')
})

test('commits are totalled per day on the day their PR merged, and charted as aligned series with zeros for quiet buckets', () => {
  const prs = [
    pr('1', '2026-10-05T10:00:00Z', 'a', { You: [2, 10, 1], Claude: [3, 20, 2] }),
    pr('2', '2026-10-05T18:00:00Z', 'a', { Claude: [1, 5, 0] }),
    pr('3', '2026-10-12T09:00:00Z', 'b', { You: [4, 8, 8] }),
  ]
  const agg = aggregate(prs, 0, 'combined')
  expect(agg.days).toEqual([
    { date: '2026-10-05', commits: { You: 2, AI: 4 } },
    { date: '2026-10-12', commits: { You: 4 } },
  ])
  const from = Date.parse('2026-10-04T00:00:00Z')
  const to = Date.parse('2026-10-14T00:00:00Z')
  const daily = commitSeries(agg.days, [YOU, ALL_AI], 'day', from, to)
  expect(daily.labels.length).toBe(11)
  expect(daily.values[YOU]![1]).toBe(2)
  expect(daily.values[ALL_AI]![1]).toBe(4)
  expect(daily.values[YOU]![0]).toBe(0)
  // Weeks start on Monday: the 5th falls in the week of the 5th (a Monday), the 12th in the next.
  const weekly = commitSeries(agg.days, [YOU, ALL_AI], 'week', from, to)
  expect(weekly.labels).toEqual(['2026-09-28', '2026-10-05', '2026-10-12'])
  expect(weekly.values[YOU]).toEqual([0, 2, 4])
  const monthly = commitSeries(agg.days, [YOU], 'month', Date.parse('2026-08-15T00:00:00Z'), to)
  expect(monthly.labels).toEqual(['2026-08', '2026-09', '2026-10'])
  expect(monthly.values[YOU]).toEqual([0, 0, 6])
})

test('the chart gets coarser as the range gets longer', () => {
  expect(bucketFor(7)).toBe('day')
  expect(bucketFor(30)).toBe('day')
  expect(bucketFor(90)).toBe('week')
  expect(bucketFor(180)).toBe('week')
  expect(bucketFor(365)).toBe('month')
  expect(bucketFor(3000)).toBe('month')
})

test('other humans fold into one, or stand on their own, and each can be hidden', () => {
  const prs = [
    pr('1', '2026-10-05T10:00:00Z', 'a', { You: [1, 1, 0], '@grant': [3, 30, 3], '@sam': [1, 5, 0] }),
    pr('2', '2026-10-06T10:00:00Z', 'a', { '@grant': [2, 4, 0] }),
  ]
  const share = (a: ReturnType<typeof aggregate>) => Object.fromEntries(a.actors.map(x => [x.actor, x.commits]))
  expect(share(aggregate(prs, 0, 'combined'))).toEqual({ You: 1, Others: 6 })
  expect(share(aggregate(prs, 0, 'combined', [], 'separate'))).toEqual({ You: 1, '@grant': 5, '@sam': 1 })
  expect(share(aggregate(prs, 0, 'combined', ['@sam'], 'separate'))).toEqual({ You: 1, '@grant': 5 })
  expect(share(aggregate(prs, 0, 'combined', ['@sam']))).toEqual({ You: 1, Others: 5 })
  expect(humansIn(prs)).toEqual(['@grant', '@sam'])
})

test('a hidden AI or human only counts while its group is shown one by one', () => {
  const hidden = ['Claude', '@sam']
  expect(hiddenInView(hidden, 'combined', 'combined')).toEqual([])
  expect(hiddenInView(hidden, 'separate', 'combined')).toEqual(['Claude'])
  expect(hiddenInView(hidden, 'combined', 'separate')).toEqual(['@sam'])
  expect(hiddenInView(hidden, 'separate', 'separate')).toEqual(['Claude', '@sam'])
})

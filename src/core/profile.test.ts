import { expect, test } from 'claude-code/testing'

import { buildProfiles, spanLabel, tokenLabel } from './profile'
import type { PrSummary, RepoCreated, RepoEffort } from './types'

const pr = (id: string, repo: string, mergedAt: string, by: PrSummary['by']): PrSummary => ({ id, repo, mergedAt, by })
const repo = (name: string, createdAt: string): RepoCreated => ({ name, createdAt, isArchived: false, isFork: false })

const prs = [
  pr('1', 'app', '2026-10-05T15:00:00Z', { You: [2, 100, 10] }),
  pr('2', 'app', '2026-10-15T10:00:00Z', { Claude: [6, 900, 90], You: [2, 50, 0] }),
  pr('3', 'app', '2026-10-15T18:00:00Z', { Claude: [2, 40, 40], Automation: [3, 1000, 1000] }),
  pr('4', 'tiny', '2026-10-16T09:00:00Z', { You: [1, 5, 0] }),
]
const repos = [repo('app', '2026-10-01T08:00:00Z'), repo('tiny', '2026-10-16T08:00:00Z')]

test('a repo is profiled from its merged PRs: size of the work, who did it, and the span of days', () => {
  const p = buildProfiles(prs, repos).find(x => x.repo === 'app')!
  expect(p.prs).toBe(3)
  expect(p.activeDays).toBe(2)
  // Created the 1st, last merged the 15th: 15 days counting both ends.
  expect(p.calendarDays).toBe(15)
  // Automation's commits and lines are left out of the commit count; lines still count what merged.
  expect(p.commits).toBe(12)
  expect(p.aiCommits).toBe(8)
  expect(Math.abs(p.aiShare - 8 / 12) < 1e-9).toBe(true)
  expect(p.adds).toBe(100 + 950 + 1040 + 0)
  expect(p.netLines).toBe(p.adds - p.dels)
  expect(p.startedAt).toBe('2026-10-01T08:00:00Z')
  expect(p.lastMergeAt).toBe('2026-10-15T18:00:00Z')
})

test('a repo made and finished the same day is one day, not none', () => {
  const p = buildProfiles(prs, repos).find(x => x.repo === 'tiny')!
  expect(p.calendarDays).toBe(1)
  expect(p.activeDays).toBe(1)
  const solo = buildProfiles([pr('9', 'x', '2026-10-16T09:00:00Z', { You: [1, 1, 0] })], [repo('x', '2026-10-16T09:00:00Z')])[0]!
  expect(solo.calendarDays).toBe(1)
})

test('a repo missing from the repo list starts at its first merge', () => {
  const p = buildProfiles(prs, [])[0]!
  expect(p.startedAt).toBe('')
  expect(p.calendarDays).toBeGreaterThan(0)
})

test('session time and releases are attached when known, and lines per hour needs real time', () => {
  const effort: Record<string, RepoEffort> = {
    app: { activeMs: 4 * 3_600_000, sessions: 3, tokens: 1_500_000, firstAt: 1, lastAt: 2 },
    tiny: { activeMs: 60_000, sessions: 1, tokens: 10, firstAt: 1, lastAt: 2 },
  }
  const out = buildProfiles(prs, repos, effort, { app: 7 })
  const app = out.find(x => x.repo === 'app')!
  expect(app.releases).toBe(7)
  expect(app.effort!.tokens).toBe(1_500_000)
  expect(Math.abs(app.linesPerHour! - app.netLines / 4) < 1e-9).toBe(true)
  // One minute of work says nothing about a rate.
  expect(out.find(x => x.repo === 'tiny')!.linesPerHour).toBe(undefined)
  expect(out.find(x => x.repo === 'tiny')!.releases).toBe(undefined)
})

test('a repo with session time but no merged PR still appears', () => {
  const out = buildProfiles([], [], { sandbox: { activeMs: 3_600_000, sessions: 1, tokens: 5, firstAt: 1, lastAt: 2 } })
  expect(out.length).toBe(1)
  expect(out[0]!.repo).toBe('sandbox')
  expect(out[0]!.prs).toBe(0)
  expect(out[0]!.calendarDays).toBe(0)
})

test('the repo worked on most recently comes first', () => {
  expect(buildProfiles(prs, repos).map(p => p.repo)).toEqual(['tiny', 'app'])
})

test('spans and token counts read at a glance', () => {
  expect(spanLabel(0)).toBe('0m')
  expect(spanLabel(45 * 60_000)).toBe('45m')
  expect(spanLabel(3 * 3_600_000 + 5 * 60_000)).toBe('3h 05m')
  expect(spanLabel(52 * 3_600_000)).toBe('2d 4h')
  expect(tokenLabel(812)).toBe('812')
  expect(tokenLabel(1_250)).toBe('1.3k')
  expect(tokenLabel(340_000)).toBe('340k')
  expect(tokenLabel(1_200_000)).toBe('1.2M')
})

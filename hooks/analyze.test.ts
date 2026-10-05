import { expect, test } from 'claude-code/testing'

import { analyze, failedOnMain, fixPrompt, snapshot, transitions } from './analyze'
import type { RawRepo } from './analyze'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const HOUR = 3_600_000

const repo = (over: Partial<RawRepo> & { head?: string; headDate?: string }): RawRepo => ({
  name: 'app',
  url: 'https://github.com/o/app',
  isArchived: false,
  isFork: false,
  pushedAt: '2026-10-05T11:00:00Z',
  defaultBranchRef: {
    name: 'main',
    target: { oid: 'a', committedDate: over.headDate ?? '2026-10-05T10:00:00Z', statusCheckRollup: { state: over.head ?? 'SUCCESS' } },
  },
  latestRelease: null,
  pullRequests: { nodes: [] },
  ...over,
})

const pr = (state: string | null, extra: object = {}) => ({
  number: 7,
  title: 'Change',
  url: 'u',
  isDraft: false,
  headRefName: 'feat',
  updatedAt: '2026-10-05T11:00:00Z',
  mergeable: 'MERGEABLE',
  commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
  ...extra,
})

test('open PR with a running build sits at Build', () => {
  const v = analyze(repo({ pullRequests: { nodes: [pr('PENDING')] } }), NOW, 6 * HOUR)
  expect(v.steps).toEqual(['done', 'running', 'todo', 'todo'])
  expect(v.level).toBe('running')
})

test('failing PR outranks a passing one', () => {
  const v = analyze(repo({ pullRequests: { nodes: [pr('SUCCESS', { number: 1 }), pr('FAILURE', { number: 2 })] } }), NOW, 6 * HOUR)
  expect(v.level).toBe('fail')
  expect(v.headline).toBe('#2 build failing')
})

test('passing PR is ready to merge', () => {
  const v = analyze(repo({ pullRequests: { nodes: [pr('SUCCESS')] } }), NOW, 6 * HOUR)
  expect(v.steps).toEqual(['done', 'done', 'todo', 'todo'])
  expect(v.level).toBe('ready')
})

test('merged commit newer than the release is awaiting release while recent', () => {
  const release = { tagName: 'v1', publishedAt: '2026-10-04T00:00:00Z' }
  const v = analyze(repo({ latestRelease: release }), NOW, 6 * HOUR)
  expect(v.steps).toEqual(['done', 'done', 'done', 'running'])
  expect(v.level).toBe('pending')
  const old = analyze(repo({ latestRelease: release, headDate: '2026-10-01T00:00:00Z' }), NOW, 6 * HOUR)
  expect(old.level).toBe('idle')
})

test('release at or after head is fully done', () => {
  const v = analyze(repo({ latestRelease: { tagName: 'v2', publishedAt: '2026-10-05T11:00:00Z' } }), NOW, 6 * HOUR)
  expect(v.steps).toEqual(['done', 'done', 'done', 'done'])
})

test('transitions toast a settled build and a new release, but never on the first poll', () => {
  const running = [analyze(repo({ head: 'PENDING', latestRelease: { tagName: 'v1', publishedAt: '2026-10-04T00:00:00Z' } }), NOW, 6 * HOUR)]
  expect(transitions({}, running)).toEqual([])
  const done = [analyze(repo({ head: 'SUCCESS', latestRelease: { tagName: 'v2', publishedAt: '2026-10-05T11:00:00Z' } }), NOW, 6 * HOUR)]
  expect(transitions(snapshot(running), done)).toEqual(['✓ app main build passed', '⬆ app v2 released — ready to download'])
})

test('an untouched repo with a conflicted PR is stale; a building one never is', () => {
  const old = { pushedAt: '2026-08-01T00:00:00Z' }
  const stale = analyze(repo({ ...old, pullRequests: { nodes: [pr('SUCCESS', { updatedAt: '2026-08-01T00:00:00Z', mergeable: 'CONFLICTING' })] } }), NOW, 6 * HOUR)
  expect(stale.isStale).toBe(true)
  const building = analyze(repo({ ...old, pullRequests: { nodes: [pr('PENDING', { updatedAt: '2026-08-01T00:00:00Z' })] } }), NOW, 6 * HOUR)
  expect(building.isStale).toBe(false)
  const fresh = analyze(repo({ pullRequests: { nodes: [pr('SUCCESS', { mergeable: 'CONFLICTING' })] } }), NOW, 6 * HOUR)
  expect(fresh.isStale).toBe(false)
})

test('failedOnMain fires once on running -> failing, never on first poll or a steady failure', () => {
  const running = [analyze(repo({ head: 'PENDING' }), NOW, 6 * HOUR)]
  const failing = [analyze(repo({ head: 'FAILURE' }), NOW, 6 * HOUR)]
  expect(failedOnMain({}, failing)).toEqual([])
  expect(failedOnMain(snapshot(running), failing).map(r => r.name)).toEqual(['app'])
  expect(failedOnMain(snapshot(failing), failing)).toEqual([])
  const prompt = fixPrompt('o', failing[0]!)
  expect(prompt).toContain('o/app')
  expect(prompt).toContain('Never push to main')
})

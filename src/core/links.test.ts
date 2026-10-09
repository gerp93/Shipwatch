import { expect, test } from 'claude-code/testing'

import { analyze } from './analyze'
import type { RawRepo } from './analyze'
import { headlineLink, safeHref, stepLinks } from './links'

const NOW = Date.parse('2026-10-05T12:00:00Z')
const HOUR = 3_600_000

const repo = (over: Partial<RawRepo> = {}, branch = 'main'): RawRepo => ({
  name: 'app',
  url: 'https://github.com/o/app',
  isArchived: false,
  isFork: false,
  pushedAt: '2026-10-05T11:00:00Z',
  defaultBranchRef: {
    name: branch,
    target: { oid: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0', committedDate: '2026-10-05T10:00:00Z', statusCheckRollup: { state: 'SUCCESS' } },
  },
  latestRelease: null,
  pullRequests: { nodes: [] },
  ...over,
})

const pr = (extra: object = {}) => ({
  number: 7,
  title: 'Change',
  url: 'https://github.com/o/app/pull/7',
  isDraft: false,
  headRefName: 'feat',
  updatedAt: '2026-10-05T11:00:00Z',
  mergeable: 'MERGEABLE',
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  ...extra,
})

test('safeHref passes the URLs GitHub gives us', () => {
  for (const url of [
    'https://github.com/o/app',
    'https://github.com/o/app/pull/7/checks',
    'https://github.com/o/app/actions/runs/123456',
    'https://github.com/o/app/actions?query=branch%3Amain',
    'https://github.com/o/app/commits/claude/feature-x',
    'https://github.com/o/app/releases/tag/v1.2.3',
  ]) {
    expect(safeHref(url)).toBe(url)
  }
})

test('safeHref drops anything the engine would refuse the pane over', () => {
  const rejected = [
    undefined,
    null,
    '',
    'http://github.com/o/app',
    'https://github.com',
    'https://github.com?x=1',
    'https://user@github.com/o/app',
    'https://github.com/o/app@x',
    'https://github.com/o/my app',
    'https://github.com/o/café',
    'https://GitHub.com/o/app',
    'https://github.com/o/app/../x',
    'https://github.com/o/app/./x',
    'https://github.com/o/app%zz',
    'https://github.com/o/app#frag',
    'https://github.com/o/app\n',
    'javascript:alert(1)',
    `https://github.com/${'a'.repeat(2048)}`,
  ]
  for (const url of rejected) expect(safeHref(url)).toBeUndefined()
})

test('step links follow the PR when there is one', () => {
  const v = analyze(repo({ pullRequests: { nodes: [pr()] } }), NOW, 6 * HOUR)
  const [prLink, build, merged, released] = stepLinks(v)
  expect(prLink).toBe('https://github.com/o/app/pull/7')
  expect(build).toBe('https://github.com/o/app/pull/7/checks')
  expect(merged).toBe('https://github.com/o/app/commits/main')
  expect(released).toBe('https://github.com/o/app/releases')
})

test('step links fall back to the repo pages with no PR, and use the latest release tag', () => {
  const v = analyze(repo({ latestRelease: { tagName: 'v1.2.3', publishedAt: '2026-10-05T11:00:00Z' } }), NOW, 6 * HOUR)
  const [prLink, build, , released] = stepLinks(v)
  expect(prLink).toBe('https://github.com/o/app/pulls')
  expect(build).toBe('https://github.com/o/app/actions?query=branch%3Amain')
  expect(released).toBe('https://github.com/o/app/releases/tag/v1.2.3')
})

test('branch names with slashes, dots or non-ASCII letters link, percent-encoded where needed', () => {
  const slashed = analyze(repo({}, 'release/2026'), NOW, 6 * HOUR)
  expect(stepLinks(slashed)[2]).toBe('https://github.com/o/app/commits/release/2026')
  expect(stepLinks(slashed)[1]).toBe('https://github.com/o/app/actions?query=branch%3Arelease%2F2026')
  const odd = analyze(repo({}, 'main..x'), NOW, 6 * HOUR)
  expect(stepLinks(odd)[2]).toBe('https://github.com/o/app/commits/main..x')
  const unicode = analyze(repo({}, 'café'), NOW, 6 * HOUR)
  expect(stepLinks(unicode)[2]).toBe('https://github.com/o/app/commits/caf%C3%A9')
})

test('a repo URL the engine would refuse leaves every step unlinked', () => {
  const v = analyze(repo({ url: 'http://github.com/o/app' }), NOW, 6 * HOUR)
  expect(stepLinks(v)).toEqual([undefined, undefined, undefined, undefined])
  expect(headlineLink(v)).toBeUndefined()
})

test('the headline links to the PR for a conflict or draft, else to the build', () => {
  const conflict = analyze(repo({ pullRequests: { nodes: [pr({ mergeable: 'CONFLICTING' })] } }), NOW, 6 * HOUR)
  expect(headlineLink(conflict)).toBe('https://github.com/o/app/pull/7')
  const draft = analyze(repo({ pullRequests: { nodes: [pr({ isDraft: true })] } }), NOW, 6 * HOUR)
  expect(headlineLink(draft)).toBe('https://github.com/o/app/pull/7')
  const building = analyze(repo({ pullRequests: { nodes: [pr({ commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } })] } }), NOW, 6 * HOUR)
  expect(headlineLink(building)).toBe('https://github.com/o/app/pull/7/checks')
})

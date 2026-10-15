import { expect, test } from 'claude-code/testing'

import { jsonForScript, openArgv, renderReport } from './report'
import type { ReportData } from './report'
import type { RepoView } from './types'

const repo = (over: Partial<RepoView> = {}): RepoView => ({
  name: 'app',
  url: 'https://github.com/o/app',
  pushedAt: '2026-10-01T00:00:00Z',
  headChecks: 'passing',
  headDate: '2026-10-01T00:00:00Z',
  branch: 'main',
  headOid: 'abc',
  release: null,
  prs: [],
  activity: [],
  steps: ['todo', 'todo', 'done', 'done'],
  level: 'idle',
  headline: '',
  isStale: false,
  isInfra: false,
  ...over,
})

const data = (over: Partial<ReportData> = {}): ReportData => ({
  generatedAt: Date.parse('2026-10-15T12:00:00Z'),
  board: { owner: 'o', repos: [repo()] },
  stats: {
    you: 'o',
    repos: [],
    prs: [{ id: '1', repo: 'app', mergedAt: '2026-10-10T00:00:00Z', by: { You: [2, 10, 1], Claude: [8, 200, 40] } }],
  },
  ...over,
})

test('data embedded in the page cannot close the script tag or break out of it', () => {
  const json = jsonForScript({ title: '</script><img src=x onerror=alert(1)>', other: 'a b' })
  expect(json).not.toContain('<')
  expect(json).not.toContain(' ')
  // And it is still the same data once the page's script reads it.
  expect(JSON.parse(json).title).toBe('</script><img src=x onerror=alert(1)>')
})

test('the report is one self-contained page with the data and the script in it', () => {
  const html = renderReport(data())
  expect(html.startsWith('<!doctype html>')).toBe(true)
  expect(html).toContain('window.SHIPWATCH_DATA=')
  expect(html).toContain('"owner":"o"')
  // Nothing is fetched: no external script, stylesheet or image, and the policy says so.
  expect(html).not.toMatch(/<script[^>]+src=/i)
  expect(html).not.toMatch(/<link /i)
  expect(html).toContain("default-src 'none'")
  expect(html.match(/<script>/g)?.length).toBe(2)
})

test('a hostile repo name or owner cannot inject markup into the page', () => {
  const html = renderReport(data({ board: { owner: '</title><script>alert(1)</script>', repos: [repo({ name: '</script><b>x' })] } }))
  expect(html).not.toContain('<title></title><script>alert')
  expect(html.match(/<\/script>/g)?.length).toBe(2)
})

test('opening the report uses the platform default program', () => {
  const bs = String.fromCharCode(92)
  const windowsPath = ['C:', 'Users', 'me', 'AppData', 'Local', 'Temp', 'shipwatch-report.html'].join(bs)
  expect(openArgv(true, false, 'C:/Users/me/AppData/Local/Temp/shipwatch-report.html')).toEqual(['cmd', '/c', 'start', '', windowsPath])
  expect(openArgv(false, true, '/tmp/r.html')).toEqual(['open', '/tmp/r.html'])
  expect(openArgv(false, false, '/tmp/r.html')).toEqual(['xdg-open', '/tmp/r.html'])
})

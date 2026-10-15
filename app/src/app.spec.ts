import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import type { IO } from '../../src/core/ports'

import { FileStore, nodeIO } from './adapters'
import { readConfig } from './config'
import { loadSavedDashboard, saveDashboard } from './collect'
import { setApiScript, setBoardScript, setBoardStatusScript, setRecentScript, setStatsScript, setStatusScript, throttled } from './live'
import { mergeFromReport } from './merge'
import type { Question } from './merge'
import { errorPage, isSafeExternalUrl, loadingPage, progressFraction } from './pages'

const tempFile = async (name: string): Promise<string> => join(await mkdtemp(join(tmpdir(), 'shipwatch-')), name)

test('the store keeps values between instances and survives a missing or damaged file', async () => {
  const path = await tempFile('stats.json')
  const first = new FileStore(path)
  assert.equal(await first.get('nothing'), undefined)
  await first.set('a', { prs: [1, 2] })
  await first.set('b', 'two')
  const second = new FileStore(path)
  assert.deepEqual(await second.get('a'), { prs: [1, 2] })
  assert.equal(await second.get('b'), 'two')

  await writeFile(path, '{ not json', 'utf8')
  assert.equal(await new FileStore(path).get('a'), undefined)
  // A damaged file is replaced by the next write rather than blocking it.
  const third = new FileStore(path)
  await third.set('c', 3)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).c, 3)
})

test('two quick writes both land, in order', async () => {
  const path = await tempFile('quick.json')
  const store = new FileStore(path)
  await Promise.all([store.set('x', 1), store.set('y', 2), store.set('x', 3)])
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { x: 3, y: 2 })
})

test('running a command reports its output and exit code; one that cannot start rejects', async () => {
  const io = nodeIO()
  const ok = await io.run([process.execPath, '-e', 'process.stdout.write("hi")'])
  assert.deepEqual([ok.exitCode, ok.stdout], [0, 'hi'])
  const failed = await io.run([process.execPath, '-e', 'process.stderr.write("bad"); process.exit(3)'])
  assert.deepEqual([failed.exitCode, failed.stderr], [3, 'bad'])
  await assert.rejects(io.run(['shipwatch-no-such-command-xyz']))
})

test('settings default sensibly, take the owner and token from the environment, and ignore junk', () => {
  const none = readConfig(undefined, {})
  assert.deepEqual([none.owner, none.token, none.count, none.staleDays, none.includeForks], ['', '', 40, 14, false])

  const set = readConfig({ owner: 'file-owner', maxRepos: 500, staleDays: 'x', ignore: ['A', 3, ' '], aiNames: ['Gemini'] }, { SHIPWATCH_OWNER: 'env-owner', GITHUB_TOKEN: 'tok' })
  assert.equal(set.owner, 'env-owner')
  assert.equal(set.token, 'tok')
  assert.equal(set.count, 100)
  assert.equal(set.staleDays, 14)
  assert.deepEqual(set.ignore, ['A'])
  assert.deepEqual(set.aiNames, ['Gemini'])
  assert.equal(readConfig('nonsense', {}).count, 40)
})

test('only ordinary web links are handed to the operating system', () => {
  assert.equal(isSafeExternalUrl('https://github.com/o/r'), true)
  assert.equal(isSafeExternalUrl('http://example.com'), true)
  for (const bad of ['file:///C:/Windows/System32/calc.exe', 'ms-msdt:/id', 'javascript:alert(1)', 'not a url', '']) {
    assert.equal(isSafeExternalUrl(bad), false, bad)
  }
})

test('an error message is shown as text, never as markup', () => {
  const html = errorPage('<img src=x onerror=alert(1)> & more')
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img'))
})

test('progress is read from the loader\'s own wording, and an unknown message leaves the bar pulsing', () => {
  assert.equal(progressFraction('Loading merged PRs 2026-09-10 to 2026-10-09: 250 of 265 (part 1 of 13)'), 0)
  assert.equal(progressFraction('Loading merged PRs x: 1 of 2 (part 7 of 13)'), 6 / 13)
  assert.equal(progressFraction('Loading merged PRs x: 1 of 2 (part 13 of 13)'), 12 / 13)
  assert.equal(progressFraction('Reading repos...'), undefined)
})

test('the loading page shows a running clock and lets the app set progress', () => {
  const html = loadingPage()
  assert.ok(html.includes('id="t"'))
  assert.ok(html.includes('window.setProgress'))
  // Only this static page may run script; the error page may not.
  assert.ok(html.includes("script-src 'unsafe-inline'"))
  assert.ok(!errorPage('x').includes('<script'))
})

// ---- Merge from the report -------------------------------------------------------------------------------

const prAnswer = (over: object = {}) => ({
  data: {
    repository: {
      autoMergeAllowed: true,
      mergeCommitAllowed: true,
      pullRequest: {
        id: 'PR_1',
        number: 7,
        title: 'Change',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        headRefOid: 'abc123',
        autoMergeRequest: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
        ...over,
      },
    },
  },
})

/** Deps whose GitHub answers `replies` in turn (the signed-in `gh` is absent, so the token is used). */
const mergeDeps = (replies: unknown[], answer: boolean, asked: Question[] = []) => {
  let calls = 0
  const io: IO = {
    run: async () => ({ exitCode: 1, stdout: '', stderr: '' }),
    fetch: async () => {
      calls++
      return { status: 200, ok: true, text: JSON.stringify(replies.shift()) }
    },
  }
  const confirm = async (q: Question): Promise<boolean> => (asked.push(q), answer)
  return { deps: { io, config: readConfig({}, { GITHUB_TOKEN: 't' }), owner: 'o', known: new Set(['app#7']), confirm }, calls: () => calls }
}

test('a merge request from the page is checked before anything is read from GitHub', async () => {
  const { deps, calls } = mergeDeps([], true)
  for (const [repo, n] of [['../x', 7], ['app', 0], ['app', 1.5], ['app', '7'], [7, 7], ['app/evil', 7]] as const) {
    assert.deepEqual(await mergeFromReport(deps, repo, n), { ok: false, message: 'That is not a pull request.', changed: false })
  }
  // A well-formed request for a PR the report does not list is refused too.
  const other = await mergeFromReport(deps, 'other', 7)
  assert.equal(other.ok, false)
  assert.ok(other.message.includes('not on this report'))
  assert.equal(calls(), 0)
})

test('a PR GitHub says cannot be merged is refused without asking the user', async () => {
  const asked: Question[] = []
  const { deps } = mergeDeps([prAnswer({ isDraft: true })], true, asked)
  const result = await mergeFromReport(deps, 'app', 7)
  assert.equal(result.ok, false)
  assert.equal(result.changed, false)
  assert.ok(result.message.includes('draft'))
  assert.equal(asked.length, 0)
})

test('the user is asked first, and declining changes nothing', async () => {
  const asked: Question[] = []
  const { deps, calls } = mergeDeps([prAnswer()], false, asked)
  const result = await mergeFromReport(deps, 'app', 7)
  assert.deepEqual(result, { ok: false, message: 'Cancelled.', changed: false })
  assert.equal(asked.length, 1)
  assert.equal(asked[0]!.action, 'Merge')
  assert.equal(calls(), 1) // only the read; no mutation was sent
})

test('confirming merges, and says the report is now out of date', async () => {
  const { deps, calls } = mergeDeps([prAnswer(), { data: { mergePullRequest: { pullRequest: { state: 'MERGED' } } } }], true)
  assert.deepEqual(await mergeFromReport(deps, 'app', 7), { ok: true, message: 'Merged #7.', changed: true })
  assert.equal(calls(), 2)
})

test('a PR still waiting on checks is offered auto-merge, worded as such', async () => {
  const asked: Question[] = []
  const pending = prAnswer({ mergeStateStatus: 'BLOCKED', commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } })
  const { deps } = mergeDeps([pending, { data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: 'x' } } } } }], true, asked)
  const result = await mergeFromReport(deps, 'app', 7)
  assert.equal(result.ok, true)
  assert.ok(asked[0]!.title.includes('when its checks pass'))
  assert.equal(asked[0]!.action, 'Turn on auto-merge')
})

test('an error from GitHub comes back as a message, not a crash', async () => {
  const { deps } = mergeDeps([prAnswer(), { errors: [{ message: 'Resource not accessible by personal access token' }], data: { mergePullRequest: null } }], true)
  const result = await mergeFromReport(deps, 'app', 7)
  assert.deepEqual(result, { ok: false, message: 'Resource not accessible by personal access token', changed: false })
})

test('what the page is told while history loads is a literal that cannot end the script early or run anything', () => {
  const hostile = { prs: [{ id: 'p', repo: '</script><img src=x onerror=alert(1)> ', mergedAt: '2026-10-01T00:00:00Z', by: {} }], repos: [], you: 'me' }
  const script = setStatsScript(hostile)
  assert.ok(script.startsWith('window.shipwatchLive&&window.shipwatchLive.setStats('))
  assert.ok(!script.includes('</script'))
  assert.ok(!script.includes(' '))
  // It is one expression that parses back to the same data.
  const arg = script.slice(script.indexOf('setStats(') + 'setStats('.length, -1)
  assert.deepEqual(JSON.parse(arg), hostile)
  assert.equal(setStatusScript(null), 'window.shipwatchLive&&window.shipwatchLive.setStatus(null)')
  assert.ok(setStatusScript({ state: 'loading', text: 'part 2 of 9', fraction: 0.1 }).includes('"fraction":0.1'))
})

test('the throttle passes the first value, drops those inside the gap, and passes the next after it', () => {
  let now = 1000
  const sent: number[] = []
  const send = throttled<number>(2000, v => void sent.push(v), () => now)
  send(1)
  now += 500
  send(2)
  now += 1400
  send(3)
  assert.deepEqual(sent, [1])
  now += 200
  send(4)
  assert.deepEqual(sent, [1, 4])
})

test('the dashboard saved last time comes back for the next start, and a missing or damaged file is simply nothing', async () => {
  const path = await tempFile('board.json')
  assert.equal(await loadSavedDashboard(path), undefined) // nothing saved yet: the very first start
  const repos = [{ name: 'app', url: 'https://github.com/o/app', level: 'idle', steps: ['done', 'done', 'done', 'done'], prs: [], headline: 'up to date' }] as never
  const recent = [{ repo: 'app', number: 3, title: 't', url: 'https://github.com/o/app/pull/3', createdAt: '2026-10-15T14:00:00Z', state: 'open', isDraft: false, checks: 'none', mergedAt: null }] as never
  await saveDashboard(path, { owner: 'me', repos, recent, at: 1_700_000_000_000 })
  const back = await loadSavedDashboard(path)
  assert.equal(back?.owner, 'me')
  assert.equal(back?.at, 1_700_000_000_000)
  assert.equal(back?.repos.length, 1)
  assert.equal(back?.recent?.length, 1)

  for (const bad of ['{ not json', '[]', '{"owner":1,"repos":[],"at":1}', '{"owner":"me","repos":"x","at":1}', '{"owner":"me","repos":[]}']) {
    await writeFile(path, bad, 'utf8')
    assert.equal(await loadSavedDashboard(path), undefined, bad)
  }
  // Saving where nothing can be written does not throw: the next start just has nothing to show.
  await saveDashboard(join(path, 'inside-a-file', 'board.json'), { owner: 'me', repos: [], at: 1 })
})

test('everything handed to the page while it is open is a literal that cannot end the script early', () => {
  const nasty = '</script><img src=x onerror=alert(1)> '
  const board = { owner: nasty, repos: [] }
  for (const script of [
    setBoardScript(board, 1, undefined),
    setBoardStatusScript({ state: 'error', text: nasty }),
    setRecentScript([{ repo: nasty, number: 1, title: nasty, url: 'https://x', createdAt: 'x', state: 'open', isDraft: false, checks: 'none', mergedAt: null }]),
    setApiScript({ graphql: { remaining: 1, limit: 5000, resetAt: 1 } }),
  ]) {
    assert.ok(script.startsWith('window.shipwatchLive&&window.shipwatchLive.set'))
    assert.ok(!script.includes('</script'))
    assert.ok(!script.includes(' '))
  }
  assert.ok(setBoardScript(board, 7, undefined).endsWith(',7,null)')) // no recent list: the page keeps the one it has
  assert.equal(setBoardStatusScript(null), 'window.shipwatchLive&&window.shipwatchLive.setBoardStatus(null)')
})

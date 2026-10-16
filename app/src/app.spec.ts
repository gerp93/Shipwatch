import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'

import { SLIM_TRANSCRIPT_SCRIPT, parseTranscript } from '../../src/core/effort'
import type { IO } from '../../src/core/ports'

import { FileStore, nodeIO } from './adapters'
import { readConfig } from './config'
import { loadSavedDashboard, saveDashboard } from './collect'
import { readEffort } from './effort'
import { setApiScript, setBoardScript, setBoardStatusScript, setRecentScript, setStatsScript, setStatusScript, throttled } from './live'
import { closeFromReport, mergeFromReport } from './merge'
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

test('a PR titled do not merge is refused without asking, however clean it looks', async () => {
  const asked: Question[] = []
  const { deps } = mergeDeps([prAnswer({ title: 'DO NOT MERGE: everything this repo changed since the original' })], true, asked)
  const result = await mergeFromReport(deps, 'app', 7)
  assert.equal(result.ok, false)
  assert.equal(result.changed, false)
  assert.ok(result.message.includes('do not merge'))
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

test('closing is checked like merging: the request is validated and the PR must be on the report, before GitHub is asked', async () => {
  const { deps, calls } = mergeDeps([], true)
  for (const [repo, n] of [['../x', 7], ['app', 0], ['app', '7'], [7, 7]] as const) {
    assert.deepEqual(await closeFromReport(deps, repo, n), { ok: false, message: 'That is not a pull request.', changed: false })
  }
  const other = await closeFromReport(deps, 'other', 7)
  assert.equal(other.ok, false)
  assert.ok(other.message.includes('not on this report'))
  assert.equal(calls(), 0)
})

test('closing asks first, and declining changes nothing', async () => {
  const asked: Question[] = []
  const { deps, calls } = mergeDeps([prAnswer()], false, asked)
  assert.deepEqual(await closeFromReport(deps, 'app', 7), { ok: false, message: 'Cancelled.', changed: false })
  assert.equal(asked.length, 1)
  assert.equal(asked[0]!.action, 'Close')
  assert.ok(asked[0]!.title.includes('app#7'))
  assert.ok(asked[0]!.detail.includes('without being merged'))
  assert.equal(calls(), 1) // only the read; nothing was closed
})

test('confirming closes the PR, and says the report is now out of date', async () => {
  const { deps, calls } = mergeDeps([prAnswer(), { data: { closePullRequest: { pullRequest: { state: 'CLOSED' } } } }], true)
  assert.deepEqual(await closeFromReport(deps, 'app', 7), { ok: true, message: 'Closed #7. You can reopen it on GitHub.', changed: true })
  assert.equal(calls(), 2)
})

test('a PR already closed or merged is refused without asking, and a draft or do-not-merge PR can still be closed', async () => {
  const asked: Question[] = []
  const merged = mergeDeps([prAnswer({ state: 'MERGED' })], true, asked)
  const refused = await closeFromReport(merged.deps, 'app', 7)
  assert.equal(refused.ok, false)
  assert.ok(refused.message.includes('already merged'))
  assert.equal(asked.length, 0)

  const draft = mergeDeps([prAnswer({ isDraft: true, title: 'DO NOT MERGE: keep open' }), { data: { closePullRequest: { pullRequest: { state: 'CLOSED' } } } }], true, asked)
  assert.equal((await closeFromReport(draft.deps, 'app', 7)).ok, true)
  assert.ok(asked[0]!.detail.includes('it is a draft'))
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
  const recent = [{ repo: 'app', number: 3, title: 't', url: 'https://github.com/o/app/pull/3', createdAt: '2026-10-15T14:00:00Z', state: 'open', isDraft: false, parked: false, checks: 'none', mergedAt: null }] as never
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
    setRecentScript([{ repo: nasty, number: 1, title: nasty, url: 'https://x', createdAt: 'x', state: 'open', isDraft: false, parked: false, checks: 'none', mergedAt: null }]),
    setApiScript({ graphql: { remaining: 1, limit: 5000, resetAt: 1 } }),
  ]) {
    assert.ok(script.startsWith('window.shipwatchLive&&window.shipwatchLive.set'))
    assert.ok(!script.includes('</script'))
    assert.ok(!script.includes(' '))
  }
  assert.ok(setBoardScript(board, 7, undefined).endsWith(',7,null)')) // no recent list: the page keeps the one it has
  assert.equal(setBoardStatusScript(null), 'window.shipwatchLive&&window.shipwatchLive.setBoardStatus(null)')
})

test('session time and tokens are read per repo from Claude Code transcripts, and kept until a file changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shipwatch-effort-'))
  const at = (min: number): string => new Date(Date.UTC(2026, 9, 15, 12, min)).toISOString()
  const line = (o: Record<string, unknown>): string => JSON.stringify(o)
  const mine = join(root, 'C--Users-me-source-repos-My-App')
  await mkdir(join(mine, 'session-1', 'subagents'), { recursive: true })
  await writeFile(join(mine, 'session-1.jsonl'), [line({ type: 'user', timestamp: at(0) }), line({ type: 'assistant', timestamp: at(6), message: { id: 'a', usage: { input_tokens: 1, output_tokens: 9 } } })].join('\n'), 'utf8')
  await writeFile(join(mine, 'session-1', 'subagents', 'agent-x.jsonl'), line({ type: 'assistant', timestamp: at(9), message: { id: 'b', usage: { output_tokens: 20 } } }), 'utf8')
  // A folder that belongs to no repo is not read at all.
  await mkdir(join(root, 'C--Users-me-AppData-Local-Temp-scratch'), { recursive: true })
  await writeFile(join(root, 'C--Users-me-AppData-Local-Temp-scratch', 's.jsonl'), line({ type: 'user', timestamp: at(0) }), 'utf8')

  const cache = join(root, 'effort.json')
  const first = await readEffort(root, ['My_App', 'Other'], cache)
  assert.deepEqual(Object.keys(first), ['My_App'])
  // 0 to 6 and 6 to 9 minutes of one session, the sub-agent's reply in the same stretch.
  assert.equal(first.My_App!.activeMs, 9 * 60_000)
  assert.equal(first.My_App!.tokens, 30)
  assert.equal(first.My_App!.sessions, 2)

  // Unchanged files come from the cache: a damaged cached transcript proves the file was not parsed again.
  const kept = JSON.parse(await readFile(cache, 'utf8')) as Record<string, { transcript: { times: number[] } }>
  assert.equal(Object.keys(kept).length, 2)
  for (const entry of Object.values(kept)) entry.transcript.times = [0]
  await writeFile(cache, JSON.stringify(kept), 'utf8')
  assert.equal((await readEffort(root, ['My_App'], cache)).My_App!.activeMs, 0)

  // A changed file is read again.
  await writeFile(join(mine, 'session-1.jsonl'), line({ type: 'user', timestamp: at(0) }) + '\n' + line({ type: 'user', timestamp: at(2) }) + '\n', 'utf8')
  assert.equal((await readEffort(root, ['My_App'], cache)).My_App!.activeMs, 2 * 60_000)
})

test('no transcripts folder, or a damaged cache, gives an empty result rather than an error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shipwatch-effort-'))
  assert.deepEqual(await readEffort(join(root, 'missing'), ['App'], join(root, 'effort.json')), {})
  await writeFile(join(root, 'effort.json'), '{ nope', 'utf8')
  assert.deepEqual(await readEffort(root, ['App'], join(root, 'effort.json')), {})
})

test('the slimming script the Claude pane runs through Node gives the same numbers as parsing the whole transcript', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shipwatch-slim-'))
  const at = (min: number, sec = 0): string => new Date(Date.UTC(2026, 9, 15, 12, min, sec)).toISOString()
  const line = (o: Record<string, unknown>): string => JSON.stringify(o)
  const reply = (id: string, min: number, output: number): string =>
    line({ type: 'assistant', timestamp: at(min), message: { id, usage: { input_tokens: 2, output_tokens: output, cache_creation_input_tokens: 5, cache_read_input_tokens: 9000 } } })
  const text = [
    line({ type: 'user', timestamp: at(0) }),
    line({ type: 'user', timestamp: at(0, 0) }),
    reply('m1', 1, 10),
    reply('m1', 1, 400),
    reply('m1', 1, 250),
    line({ type: 'summary' }),
    'not json but "timestamp"',
    reply('m2', 4, 7),
    line({ requestId: 'r1', type: 'assistant', timestamp: at(5), message: { usage: { output_tokens: 3 } } }),
  ].join('\n')
  const path = join(root, 's.jsonl')
  await writeFile(path, text, 'utf8')
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', SLIM_TRANSCRIPT_SCRIPT, path])
  const whole = parseTranscript(text)
  const slim = parseTranscript(stdout)
  assert.deepEqual(slim.times, whole.times)
  assert.deepEqual([...slim.usage].sort(), [...whole.usage].sort())
  assert.ok(stdout.length < text.length)
})

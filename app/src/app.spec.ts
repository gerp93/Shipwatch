import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { FileStore, nodeIO } from './adapters'
import { readConfig } from './config'
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

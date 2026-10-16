import { expect, test } from 'claude-code/testing'

import { ACTIVE_GAP_MS, ENGINE_READ_LIMIT, SLIM_TRANSCRIPT_SCRIPT, collectEffort, engineEffortHost, foldEffort, parseTranscript, repoForProject, transcriptsDirFor } from './effort'
import type { EffortEntry, EffortHost } from './effort'

const at = (min: number, sec = 0): string => new Date(Date.UTC(2026, 9, 15, 12, min, sec)).toISOString()
const event = (over: Record<string, unknown>): string => JSON.stringify(over)
const reply = (id: string, min: number, usage: Record<string, number>): string =>
  event({ type: 'assistant', timestamp: at(min), message: { id, usage } })

test('a transcript gives its event times once each and the tokens of every reply', () => {
  const text = [
    event({ type: 'user', timestamp: at(0) }),
    reply('m1', 1, { input_tokens: 2, output_tokens: 100, cache_creation_input_tokens: 50, cache_read_input_tokens: 9000 }),
    event({ type: 'user', timestamp: at(1) }),
    'not json at all with "timestamp" in it',
    event({ type: 'last-prompt' }),
  ].join('\n')
  const t = parseTranscript(text)
  expect(t.times.length).toBe(2)
  expect(t.times[1]! - t.times[0]!).toBe(60)
  // New input, output and cache writes; reading the cache back is not counted.
  expect(t.usage).toEqual([['m1', 152]])
})

test('a reply streamed in pieces counts once, at its largest', () => {
  const t = parseTranscript([reply('m1', 0, { output_tokens: 10 }), reply('m1', 0, { output_tokens: 400 }), reply('m1', 0, { output_tokens: 250 })].join('\n'))
  expect(t.usage).toEqual([['m1', 400]])
})

test('active time adds the gaps between events and leaves out breaks', () => {
  const a = parseTranscript([event({ timestamp: at(0) }), event({ timestamp: at(5) }), event({ timestamp: at(8) }), event({ timestamp: at(60) }), event({ timestamp: at(61) })].join('\n'))
  const out = foldEffort([{ repo: 'app', transcript: a }])
  // 5 + 3 minutes, a 52 minute break, then 1 more.
  expect(out.app!.activeMs).toBe(9 * 60_000)
  expect(out.app!.sessions).toBe(1)
  expect(out.app!.firstAt).toBe(Date.UTC(2026, 9, 15, 12, 0))
  expect(out.app!.lastAt).toBe(Date.UTC(2026, 9, 15, 13, 1))
})

test('a gap exactly at the limit still counts, one second over does not', () => {
  const edge = Math.round(ACTIVE_GAP_MS / 1000)
  const t = parseTranscript([event({ timestamp: at(0) }), event({ timestamp: at(0, edge) }), event({ timestamp: at(0, edge * 2 + 1) })].join('\n'))
  expect(foldEffort([{ repo: 'app', transcript: t }]).app!.activeMs).toBe(ACTIVE_GAP_MS)
})

test('sessions open at the same time count their overlap once, and a repeated reply counts once', () => {
  const one = parseTranscript([event({ timestamp: at(0) }), reply('shared', 4, { output_tokens: 100 }), event({ timestamp: at(8) })].join('\n'))
  const two = parseTranscript([event({ timestamp: at(2) }), reply('shared', 4, { output_tokens: 100 }), reply('own', 6, { output_tokens: 30 }), event({ timestamp: at(8) })].join('\n'))
  const out = foldEffort([
    { repo: 'app', transcript: one },
    { repo: 'app', transcript: two },
    { repo: 'other', transcript: one },
  ])
  expect(out.app!.activeMs).toBe(8 * 60_000)
  expect(out.app!.sessions).toBe(2)
  expect(out.app!.tokens).toBe(130)
  expect(out.other!.tokens).toBe(100)
})

test('an empty transcript adds nothing', () => {
  expect(foldEffort([{ repo: 'app', transcript: parseTranscript('') }])).toEqual({})
})

test('a project folder is matched to the repo whose name ends it, however the path was spelled', () => {
  const repos = ['Shipwatch', 'KVG_RGB', 'KVG_Standards', 'card-judge', 'judge', 'hArdpoInt']
  expect(repoForProject('C--Users-kgerp-source-repos-Shipwatch', repos)).toBe('Shipwatch')
  expect(repoForProject('C--Users-kgerp-source-repos-KVG-RGB', repos)).toBe('KVG_RGB')
  expect(repoForProject('c--users-kgerp-source-repos-kvg-standards', repos)).toBe('KVG_Standards')
  expect(repoForProject('C--Users-kgerp-OneDrive-Documentos-Hardpoint', repos)).toBe('hArdpoInt')
  // The longest name wins: this folder is card-judge's, not judge's.
  expect(repoForProject('C--Users-kgerp-source-repos-card-judge', repos)).toBe('card-judge')
  expect(repoForProject('C--Users-kgerp-source-repos-judge', repos)).toBe('judge')
})

test('a worktree folder belongs to its repo, and a folder that merely contains the name does not', () => {
  const repos = ['Shipwatch', 'ship']
  expect(repoForProject('C--Users-kgerp-source-repos-Shipwatch--claude-worktrees-fix-a', repos)).toBe('Shipwatch')
  expect(repoForProject('C--Users-kgerp-source-repos-Shipwatcher', repos)).toBe(undefined)
  expect(repoForProject('C--Users-kgerp-AppData-Local-Temp-valutique-05e6cdfc', repos)).toBe(undefined)
  expect(repoForProject('ssh-823d8eaa-c351', repos)).toBe(undefined)
})

// A fake computer: a map from folder to its entries, and from file to its text.
const file = (name: string, size = 100, mtimeMs = 1): EffortEntry => ({ name, kind: 'file', size, mtimeMs })
const dirEntry = (name: string): EffortEntry => ({ name, kind: 'dir', size: 0, mtimeMs: 0 })
const fakeHost = (folders: Record<string, EffortEntry[]>, texts: Record<string, string>, reads: string[] = []): EffortHost => ({
  list: async path => folders[path] ?? [],
  read: async path => {
    reads.push(path)
    return texts[path]
  },
})

test('the folder walk finds sessions and sub-agents of the repos it knows, and reads nothing else', async () => {
  const mine = 'root/C--src-My-App'
  const reads: string[] = []
  const host = fakeHost(
    {
      root: [dirEntry('C--src-My-App'), dirEntry('C--src-scratch'), file('stray.jsonl')],
      [mine]: [file('s1.jsonl'), file('notes.txt'), dirEntry('s1')],
      [`${mine}/s1/subagents`]: [file('agent-x.jsonl')],
      'root/C--src-scratch': [file('s.jsonl')],
    },
    {
      [`${mine}/s1.jsonl`]: [event({ type: 'user', timestamp: at(0) }), reply('a', 6, { input_tokens: 1, output_tokens: 9 })].join('\n'),
      [`${mine}/s1/subagents/agent-x.jsonl`]: reply('b', 9, { output_tokens: 20 }),
    },
    reads,
  )
  const out = await collectEffort(host, 'root', ['My_App', 'Other'])
  expect(Object.keys(out.effort)).toEqual(['My_App'])
  expect(out.effort.My_App!.activeMs).toBe(9 * 60_000)
  expect(out.effort.My_App!.tokens).toBe(30)
  expect(out.effort.My_App!.sessions).toBe(2)
  expect(out.skipped).toBe(0)
  expect(reads.sort()).toEqual([`${mine}/s1.jsonl`, `${mine}/s1/subagents/agent-x.jsonl`])
})

test('a file whose size and time are unchanged comes from the cache, and one that cannot be read is counted', async () => {
  const folder = 'root/C--src-App'
  const folders = { root: [dirEntry('C--src-App')], [folder]: [file('a.jsonl', 10, 5), file('b.jsonl', 10, 5)] }
  const texts = { [`${folder}/a.jsonl`]: event({ type: 'user', timestamp: at(0) }) + '\n' + event({ type: 'user', timestamp: at(3) }) }
  const first = await collectEffort(fakeHost(folders, texts), 'root', ['App'])
  expect(first.effort.App!.activeMs).toBe(3 * 60_000)
  expect(first.skipped).toBe(1)
  expect(Object.keys(first.cache)).toEqual([`${folder}/a.jsonl`])

  const reads: string[] = []
  const second = await collectEffort(fakeHost(folders, texts, reads), 'root', ['App'], first.cache)
  expect(second.effort.App!.activeMs).toBe(3 * 60_000)
  // Only the file that failed is tried again.
  expect(reads).toEqual([`${folder}/b.jsonl`])

  // A file that changed is read again.
  const changed = { root: folders.root, [folder]: [file('a.jsonl', 20, 6)] }
  const third = await collectEffort(fakeHost(changed, { [`${folder}/a.jsonl`]: event({ type: 'user', timestamp: at(0) }) }), 'root', ['App'], first.cache)
  expect(third.effort.App!.activeMs).toBe(0)
})

test('a missing transcripts folder gives nothing', async () => {
  const out = await collectEffort(fakeHost({}, {}), 'nowhere', ['App'])
  expect(out.effort).toEqual({})
  expect(out.skipped).toBe(0)
})

test('the transcripts folder is under CLAUDE_CONFIG_DIR, else the home folder', () => {
  expect(transcriptsDirFor({ CLAUDE_CONFIG_DIR: '/cfg/', HOME: '/home/me' })).toBe('/cfg/projects')
  expect(transcriptsDirFor({ HOME: '/home/me/' })).toBe('/home/me/.claude/projects')
  expect(transcriptsDirFor({ USERPROFILE: 'C:\\Users\\me' })).toBe('C:\\Users\\me/.claude/projects')
  expect(transcriptsDirFor({})).toBe(undefined)
})

test('the slimming script is one line with nothing a command line would mangle', () => {
  expect(SLIM_TRANSCRIPT_SCRIPT.includes('\n')).toBe(false)
  expect(SLIM_TRANSCRIPT_SCRIPT.includes('"')).toBe(false)
})

test('through the engine, Node reduces a transcript; without Node a file that fits is read whole and a big one is left out', async () => {
  const runs: string[][] = []
  let nodeWorks = true
  const engine = {
    list: async () => [] as EffortEntry[],
    read: async (path: string) => `whole:${path}`,
    run: async (argv: readonly string[]) => {
      runs.push([...argv])
      if (!nodeWorks) throw new Error('spawn node ENOENT')
      return { exitCode: 0, stdout: `slim:${argv[3]}` }
    },
  }
  const host = engineEffortHost(engine)
  expect(await host.read('a.jsonl', ENGINE_READ_LIMIT * 10)).toBe('slim:a.jsonl')
  expect(runs[0]!.slice(0, 3)).toEqual(['node', '-e', SLIM_TRANSCRIPT_SCRIPT])

  nodeWorks = false
  expect(await host.read('small.jsonl', 1000)).toBe('whole:small.jsonl')
  expect(await host.read('big.jsonl', ENGINE_READ_LIMIT + 1)).toBe(undefined)
  // Node is not tried again once it could not start.
  expect(runs.length).toBe(2)
})

test('through the engine, Node output that was cut short is not trusted', async () => {
  const host = engineEffortHost({
    list: async () => [],
    read: async () => 'whole',
    run: async () => ({ exitCode: 0, stdout: 'cut', isStdoutTruncated: true }),
  })
  expect(await host.read('a.jsonl', 10)).toBe('whole')
  expect(await host.read('b.jsonl', ENGINE_READ_LIMIT + 1)).toBe(undefined)
})

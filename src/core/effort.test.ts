import { expect, test } from 'claude-code/testing'

import { ACTIVE_GAP_MS, foldEffort, parseTranscript, repoForProject } from './effort'

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

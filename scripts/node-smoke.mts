// A second host for Shipwatch's core: plain Node, no Claude engine. It is what an app or a web report
// would do: supply `IO` (run gh), a `Store` (here, in memory) and the time, and let the core do the rest.
// Also a live check that the core really runs outside the engine.
//
//   npx -y tsx scripts/node-smoke.mts          (needs the gh CLI signed in)
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { buildBoard } from '../src/core/boardService'
import { connect, resolveOwner } from '../src/core/github'
import type { IO, Store } from '../src/core/ports'
import { aggregate, aisIn, sinceFor } from '../src/core/stats'
import { refreshStats } from '../src/core/statsService'
import type { StatsBoard } from '../src/core/types'

const run = promisify(execFile)

const io: IO = {
  run: async (argv, init) => {
    try {
      const { stdout, stderr } = await run(argv[0]!, argv.slice(1) as string[], {
        timeout: init?.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024,
        encoding: 'utf8',
      })
      return { exitCode: 0, stdout, stderr }
    } catch (e: any) {
      return { exitCode: typeof e.code === 'number' ? e.code : 1, stdout: e.stdout ?? '', stderr: e.stderr ?? String(e) }
    }
  },
  fetch: async () => {
    throw new Error('no HTTP needed with gh')
  },
}

const data = new Map<string, unknown>()
const store: Store = { get: async k => data.get(k), set: async (k, v) => void data.set(k, JSON.parse(JSON.stringify(v))) }

const access = await connect(io, '')
const owner = await resolveOwner(io, access, '')
const now = Date.now()
console.log(`connected via ${access.source} as ${owner}`)

const repos = await buildBoard(
  io,
  access,
  { owner, count: 40, includeForks: false, ignore: new Set(), staleMs: 14 * 86_400_000 },
  now,
  new Map(),
)
console.log(`board: ${repos.length} repos; most urgent:`)
for (const r of repos.slice(0, 5)) console.log(`  ${r.name.padEnd(22)} ${r.level.padEnd(8)} ${r.headline}`)

const empty: StatsBoard = {
  range: 7, mode: 'combined', hidden: [], prs: [], repos: [], coveredFrom: '', coveredThrough: '',
  you: '', isLoading: false, progress: '', error: null, updatedAt: 0,
}
let last = ''
const cache = await refreshStats({ io, access, store, owner, aiNames: [], now, onProgress: t => (last = t) }, empty)
console.log(`stats (7 days): ${cache.prs.length} PRs held, ${cache.repos.length} repos listed; you = ${cache.you}; last progress: ${last}`)
const agg = aggregate(cache.prs, sinceFor(7, now), 'separate')
for (const a of agg.actors) console.log(`  ${a.actor.padEnd(10)} ${String(a.commits).padStart(4)} commits  +${a.adds} -${a.dels}  ${a.prs} PRs`)
console.log('AIs seen:', aisIn(cache.prs).join(', '))
console.log('stored for next time:', [...data.keys()].join(', '))


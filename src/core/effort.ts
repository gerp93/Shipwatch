import type { RepoEffort } from './types'

// What building a repo took, read from Claude Code's own session transcripts (one JSON object per line, each
// event stamped with its time, each assistant reply with the tokens it used). The core only turns text into
// numbers; reading the folder is the host's business, since the core has no file access.

/** Events further apart than this are a break (lunch, a night away), not time spent. */
export const ACTIVE_GAP_MS = 10 * 60_000

/** One session transcript boiled down so it can be kept and not read again until the file changes. */
export type Transcript = {
  /** The seconds (epoch) at which something happened, each once, oldest first. */
  times: number[]
  /** Tokens per assistant reply, by the reply's id: a resumed session repeats replies, so they are counted by id. */
  usage: Array<[id: string, tokens: number]>
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

/** The tokens one reply took in and wrote. Reading the cache back is left out: it repeats what was already counted. */
const tokensOf = (usage: unknown): number => {
  const u = usage && typeof usage === 'object' ? (usage as Record<string, unknown>) : {}
  return num(u.input_tokens) + num(u.output_tokens) + num(u.cache_creation_input_tokens)
}

/** Reads the text of a transcript file. Lines that are not events (or not JSON) are skipped. */
export const parseTranscript = (text: string): Transcript => {
  const seen = new Set<number>()
  const usage = new Map<string, number>()
  for (const line of text.split('\n')) {
    if (!line.includes('"timestamp"')) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const at = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN
    if (!Number.isFinite(at)) continue
    seen.add(Math.floor(at / 1000))
    const message = event.message
    if (event.type === 'assistant' && message && typeof message === 'object') {
      const m = message as Record<string, unknown>
      const tokens = tokensOf(m.usage)
      // A reply streamed in pieces appears more than once, growing; the largest is the whole of it.
      if (tokens > 0) {
        const id = typeof m.id === 'string' ? m.id : typeof event.requestId === 'string' ? event.requestId : ''
        if (id) usage.set(id, Math.max(usage.get(id) ?? 0, tokens))
      }
    }
  }
  return { times: [...seen].sort((a, b) => a - b), usage: [...usage] }
}

/**
 * Which repo a Claude Code project folder belongs to. Claude Code names the folder after the working directory
 * with every character that is not a letter or digit turned into `-` (`C:\\src\\my_app` is `C--src-my-app`), so a
 * repo matches when its name, written the same way, ends the folder's name (case aside), or ends it before a
 * worktree suffix. The longest such name wins, so `card-judge` is not mistaken for `judge`.
 */
export const repoForProject = (folder: string, repoNames: readonly string[]): string | undefined => {
  const dir = folder.toLowerCase()
  let best: string | undefined
  let bestLen = 0
  for (const name of repoNames) {
    const enc = name.replace(/[^A-Za-z0-9]/g, '-').toLowerCase()
    if (!enc || enc.length <= bestLen) continue
    const tail = dir.endsWith(enc) && (dir.length === enc.length || dir[dir.length - enc.length - 1] === '-')
    const worktree = dir.includes(`-${enc}--claude-worktrees-`)
    if (tail || worktree) {
      best = name
      bestLen = enc.length
    }
  }
  return best
}

/**
 * Adds up the transcripts of each repo: active time, sessions and tokens. Sessions that overlap in time (several
 * open at once) count the overlap once, and a reply repeated across transcripts counts once.
 */
export const foldEffort = (items: ReadonlyArray<{ repo: string; transcript: Transcript }>, gapMs: number = ACTIVE_GAP_MS): Record<string, RepoEffort> => {
  const by = new Map<string, { times: Set<number>; sessions: number; usage: Map<string, number> }>()
  for (const { repo, transcript } of items) {
    if (transcript.times.length === 0) continue
    const slot = by.get(repo) ?? { times: new Set<number>(), sessions: 0, usage: new Map<string, number>() }
    by.set(repo, slot)
    slot.sessions++
    for (const t of transcript.times) slot.times.add(t)
    for (const [id, tokens] of transcript.usage) slot.usage.set(id, Math.max(slot.usage.get(id) ?? 0, tokens))
  }
  const out: Record<string, RepoEffort> = {}
  for (const [repo, slot] of by) {
    const times = [...slot.times].sort((a, b) => a - b)
    let activeMs = 0
    for (let i = 1; i < times.length; i++) {
      const gap = (times[i]! - times[i - 1]!) * 1000
      if (gap <= gapMs) activeMs += gap
    }
    let tokens = 0
    for (const n of slot.usage.values()) tokens += n
    out[repo] = { activeMs, sessions: slot.sessions, tokens, firstAt: times[0]! * 1000, lastAt: times[times.length - 1]! * 1000 }
  }
  return out
}

// ---- Reading the folder -------------------------------------------------------------------------------------
// The core has no file access, so the walk below goes through `EffortHost`, which each outlet supplies: the app from
// `node:fs`, the Claude pane from the engine's `$.fs` and `$.process`.

/** One entry of a folder. Files carry their size (bytes) and modified time; both are 0 for anything else. */
export type EffortEntry = { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number }

export type EffortHost = {
  /** The entries of a folder; empty when it is missing or cannot be read. */
  list: (path: string) => Promise<EffortEntry[]>
  /**
   * The text of a transcript, or of a reduction of it that `parseTranscript` reads the same (see `SLIM_TRANSCRIPT_SCRIPT`).
   * Undefined when it cannot be read; that file is then left out and counted as skipped.
   */
  read: (path: string, size: number) => Promise<string | undefined>
}

/** A transcript already read, with the size and time of the file it came from; it is read again only if either changed. */
export type KeptTranscript = { size: number; mtimeMs: number; transcript: Transcript }

export type EffortRead = {
  effort: Record<string, RepoEffort>
  /** What was read, keyed by file, for the host to keep and pass back as `before`. */
  cache: Record<string, KeptTranscript>
  /** Transcript files that could not be read, so the numbers are short by their share. */
  skipped: number
}

type TranscriptFile = { path: string; size: number; mtimeMs: number }

const READ_AT_ONCE = 6

/** The transcript files in a project folder: its sessions, and the sub-agents each one started. */
const transcriptFiles = async (host: EffortHost, folder: string): Promise<TranscriptFile[]> => {
  const out: TranscriptFile[] = []
  for (const entry of await host.list(folder)) {
    if (entry.kind === 'file' && entry.name.endsWith('.jsonl')) out.push({ path: `${folder}/${entry.name}`, size: entry.size, mtimeMs: entry.mtimeMs })
    else if (entry.kind === 'dir') {
      const sub = `${folder}/${entry.name}/subagents`
      for (const f of await host.list(sub)) if (f.kind === 'file' && f.name.endsWith('.jsonl')) out.push({ path: `${sub}/${f.name}`, size: f.size, mtimeMs: f.mtimeMs })
    }
  }
  return out
}

/**
 * Session time and tokens per repo, from the transcripts folder `dir`. A project folder is matched to a repo by name
 * (see `repoForProject`); folders that match none are not read. A file whose size and time match its entry in `before`
 * is not read again. Repos with no transcripts are left out.
 */
export const collectEffort = async (host: EffortHost, dir: string, repoNames: readonly string[], before: Record<string, KeptTranscript> = {}): Promise<EffortRead> => {
  const files: Array<TranscriptFile & { repo: string }> = []
  for (const folder of await host.list(dir)) {
    if (folder.kind !== 'dir') continue
    const repo = repoForProject(folder.name, repoNames)
    if (!repo) continue
    for (const f of await transcriptFiles(host, `${dir}/${folder.name}`)) files.push({ repo, ...f })
  }
  const cache: Record<string, KeptTranscript> = {}
  const items: Array<{ repo: string; transcript: Transcript }> = []
  let skipped = 0
  const readOne = async (file: TranscriptFile & { repo: string }): Promise<void> => {
    const kept = before[file.path]
    let transcript: Transcript | undefined = kept && kept.size === file.size && kept.mtimeMs === file.mtimeMs ? kept.transcript : undefined
    if (!transcript) {
      try {
        const text = await host.read(file.path, file.size)
        if (text !== undefined) transcript = parseTranscript(text)
      } catch {
        // Counted as skipped below.
      }
    }
    if (!transcript) {
      skipped++
      return
    }
    cache[file.path] = { size: file.size, mtimeMs: file.mtimeMs, transcript }
    items.push({ repo: file.repo, transcript })
  }
  for (let i = 0; i < files.length; i += READ_AT_ONCE) await Promise.all(files.slice(i, i + READ_AT_ONCE).map(readOne))
  return { effort: foldEffort(items), cache, skipped }
}

/** Where Claude Code keeps its transcripts: under `CLAUDE_CONFIG_DIR` when that is set, else `~/.claude`. Undefined when the home folder is not known. */
export const transcriptsDirFor = (env: { CLAUDE_CONFIG_DIR?: string; HOME?: string; USERPROFILE?: string }): string | undefined => {
  const home = env.HOME || env.USERPROFILE
  const config = env.CLAUDE_CONFIG_DIR || (home ? `${home.replace(/[\\/]+$/, '')}/.claude` : undefined)
  return config ? `${config.replace(/[\\/]+$/, '')}/projects` : undefined
}

/**
 * A one-line Node program (`node -e`, the transcript's path as the argument) that boils a transcript down to what
 * `parseTranscript` needs: one `{"timestamp"}` line per second with an event in it, then one line per reply with its
 * largest token count. For a host that cannot read a big file whole (the engine's reads stop at 4 MiB); the output is
 * a few percent of the input. It has no double quotes, newlines or shell characters, so it survives being an argument.
 */
export const SLIM_TRANSCRIPT_SCRIPT = [
  `const rl=require('readline').createInterface({input:require('fs').createReadStream(process.argv[1])})`,
  `const sec=new Set(),rep=new Map(),n=v=>typeof v==='number'&&isFinite(v)?v:0`,
  `rl.on('line',l=>{if(!l.includes('\\x22timestamp\\x22'))return`,
  `let e;try{e=JSON.parse(l)}catch(x){return}`,
  `const t=Date.parse(e.timestamp);if(!isFinite(t))return`,
  `sec.add(Math.floor(t/1000))`,
  `const m=e.message,u=e.type==='assistant'&&m&&typeof m==='object'&&m.usage;if(!u||typeof u!=='object')return`,
  `const k=n(u.input_tokens)+n(u.output_tokens)+n(u.cache_creation_input_tokens),id=typeof m.id==='string'?m.id:typeof e.requestId==='string'?e.requestId:''`,
  `if(k>0&&id){const p=rep.get(id);if(!p||k>p[1])rep.set(id,[e.timestamp,k])}})`,
  `rl.on('close',()=>{const o=[];for(const s of sec)o.push(JSON.stringify({timestamp:new Date(s*1000).toISOString()}))`,
  `for(const [id,p] of rep)o.push(JSON.stringify({type:'assistant',timestamp:p[0],message:{id:id,usage:{output_tokens:p[1]}}}))`,
  `process.stdout.write(o.join('\\n'))})`,
].join(';')

/** What the engine's file reads stop at (4 MiB), with a little to spare. */
export const ENGINE_READ_LIMIT = 4 * 1024 * 1024 - 1024

/** The engine's calls the pane's host is built from: `$.fs.list`, `$.fs.read` and `$.process.run` (see `hooks/register.tsx`). */
export type EffortEngine = {
  list: (path: string) => Promise<EffortEntry[]>
  read: (path: string) => Promise<string>
  run: (argv: readonly string[], init: { timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; isStdoutTruncated?: boolean }>
}

/**
 * An `EffortHost` over the engine. A transcript is reduced by Node when Node can be run (fast, and no size limit); else,
 * or when that fails, it is read whole if it fits under the engine's limit, and left out (counted as skipped) if not.
 */
export const engineEffortHost = (engine: EffortEngine): EffortHost => {
  let canRunNode = true
  return {
    list: async path => {
      try {
        return await engine.list(path)
      } catch {
        return []
      }
    },
    read: async (path, size) => {
      if (canRunNode) {
        try {
          const r = await engine.run(['node', '-e', SLIM_TRANSCRIPT_SCRIPT, path], { timeoutMs: 120_000 })
          if (r.exitCode === 0 && !r.isStdoutTruncated) return r.stdout
        } catch {
          canRunNode = false
        }
      }
      if (size > ENGINE_READ_LIMIT) return undefined
      try {
        return await engine.read(path)
      } catch {
        return undefined
      }
    },
  }
}

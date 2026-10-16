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

// Reads Claude Code's session transcripts from this computer (`~/.claude/projects`, one folder per working
// directory) and adds up, per repo, the time spent and the tokens used. The parsing and adding up is the core's
// (src/core/effort.ts); this file only finds and reads the files. Everything stays on this machine: the numbers
// go to the report page and a cache file in the app's data folder, nowhere else.

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { collectEffort } from '../../src/core/effort'
import type { EffortEntry, EffortHost, KeptTranscript } from '../../src/core/effort'
import type { RepoEffort } from '../../src/core/types'

/** Where Claude Code keeps its transcripts: under `CLAUDE_CONFIG_DIR` when that is set, else `~/.claude`. */
export const transcriptsDir = (env: Record<string, string | undefined> = process.env): string => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

type Cache = Record<string, KeptTranscript>

const loadCache = async (path: string): Promise<Cache> => {
  try {
    const v = JSON.parse(await readFile(path, 'utf8')) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Cache) : {}
  } catch {
    return {}
  }
}

const saveCache = async (path: string, cache: Cache): Promise<void> => {
  try {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(cache), 'utf8')
    await rename(tmp, path)
  } catch {
    // Without a cache the next read just parses everything again.
  }
}

/** The core's walk over this computer's files. */
const host: EffortHost = {
  list: async path => {
    const out: EffortEntry[] = []
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const kind = entry.isFile() ? 'file' : entry.isDirectory() ? 'dir' : 'other'
      const info = kind === 'file' ? await stat(join(path, entry.name)).catch(() => undefined) : undefined
      if (kind === 'file' && !info) continue
      out.push({ name: entry.name, kind, size: info?.size ?? 0, mtimeMs: info?.mtimeMs ?? 0 })
    }
    return out
  },
  read: path => readFile(path, 'utf8'),
}

/**
 * Session time and tokens per repo (the walk is the core's: see `collectEffort`). Files are parsed once and kept in
 * `cachePath` until they change. Returns nothing for repos with no transcripts, and an empty result when there is no
 * transcripts folder.
 */
export const readEffort = async (dir: string, repoNames: readonly string[], cachePath: string): Promise<Record<string, RepoEffort>> => {
  const { effort, cache } = await collectEffort(host, dir, repoNames, await loadCache(cachePath))
  await saveCache(cachePath, cache)
  return effort
}

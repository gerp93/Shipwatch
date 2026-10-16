// Reads Claude Code's session transcripts from this computer (`~/.claude/projects`, one folder per working
// directory) and adds up, per repo, the time spent and the tokens used. The parsing and adding up is the core's
// (src/core/effort.ts); this file only finds and reads the files. Everything stays on this machine: the numbers
// go to the report page and a cache file in the app's data folder, nowhere else.

import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { foldEffort, parseTranscript, repoForProject } from '../../src/core/effort'
import type { Transcript } from '../../src/core/effort'
import type { RepoEffort } from '../../src/core/types'

/** Where Claude Code keeps its transcripts: under `CLAUDE_CONFIG_DIR` when that is set, else `~/.claude`. */
export const transcriptsDir = (env: Record<string, string | undefined> = process.env): string => join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

/** A transcript already read, with the size and time of the file it came from; it is read again only if either changed. */
type Kept = { size: number; mtimeMs: number; transcript: Transcript }
type Cache = Record<string, Kept>

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

/** The transcript files in a project folder: its sessions, and the sub-agents each one started. */
const transcriptFiles = async (folder: string): Promise<string[]> => {
  const out: string[] = []
  for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(join(folder, entry.name))
    else if (entry.isDirectory()) {
      const sub = join(folder, entry.name, 'subagents')
      for (const f of await readdir(sub).catch(() => [])) if (f.endsWith('.jsonl')) out.push(join(sub, f))
    }
  }
  return out
}

/**
 * Session time and tokens per repo. A project folder is matched to a repo by name (see `repoForProject`); folders
 * that match none are not read. Files are parsed once and kept in `cachePath` until they change. Returns nothing
 * for repos with no transcripts, and an empty result when there is no transcripts folder.
 */
export const readEffort = async (dir: string, repoNames: readonly string[], cachePath: string): Promise<Record<string, RepoEffort>> => {
  const folders = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const before = await loadCache(cachePath)
  const after: Cache = {}
  const items: Array<{ repo: string; transcript: Transcript }> = []
  for (const folder of folders) {
    if (!folder.isDirectory()) continue
    const repo = repoForProject(folder.name, repoNames)
    if (!repo) continue
    for (const file of await transcriptFiles(join(dir, folder.name))) {
      const info = await stat(file).catch(() => undefined)
      if (!info) continue
      const key = file
      const kept = before[key]
      let transcript: Transcript
      if (kept && kept.size === info.size && kept.mtimeMs === info.mtimeMs) transcript = kept.transcript
      else {
        try {
          transcript = parseTranscript(await readFile(file, 'utf8'))
        } catch {
          continue
        }
      }
      after[key] = { size: info.size, mtimeMs: info.mtimeMs, transcript }
      items.push({ repo, transcript })
    }
  }
  await saveCache(cachePath, after)
  return foldEffort(items)
}

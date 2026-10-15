// What the Shipwatch core asks of its host (see src/core/ports.ts), supplied from Node: `gh` and HTTP for
// reaching GitHub, a JSON file for keeping the stats history between runs. The Claude pane supplies the same
// three from the mod engine; nothing else about GitHub or the numbers lives here.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { IO, Store } from '../../src/core/ports'

const MAX_OUTPUT = 32 * 1024 * 1024

/** Runs a command by its argument vector (no shell) and resolves whatever happened, any exit code. */
export const nodeIO = (): IO => ({
  run: (argv, init) =>
    new Promise((resolve, reject) => {
      const [file, ...args] = argv
      if (!file) return reject(new Error('Nothing to run'))
      execFile(file, args, { timeout: init?.timeoutMs ?? 30_000, maxBuffer: MAX_OUTPUT, windowsHide: true }, (err, stdout, stderr) => {
        // A non-zero exit is an answer, not a failure; only "could not start" rejects.
        const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : err ? 1 : 0
        if (err && (err as { code?: unknown }).code === 'ENOENT') return reject(err)
        resolve({ exitCode: code, stdout: String(stdout), stderr: String(stderr) })
      })
    }),
  fetch: async (url, init) => {
    const res = await fetch(url, { method: init?.method, headers: init?.headers, body: init?.body })
    return { status: res.status, ok: res.ok, text: await res.text() }
  },
})

/**
 * Keeps values in one JSON file. A write goes to a temporary file first and is renamed over the real one, so
 * a crash mid-write leaves the old history rather than half a file. An unreadable file reads as empty: the
 * history is a cache and the core refetches what is missing.
 */
export class FileStore implements Store {
  private loading: Promise<Record<string, unknown>> | undefined
  private queue: Promise<void> = Promise.resolve()

  constructor(private readonly path: string) {}

  /** The file's contents, read once; every caller shares the same object, so concurrent sets cannot diverge. */
  private load(): Promise<Record<string, unknown>> {
    this.loading ??= readFile(this.path, 'utf8')
      .then((text): Record<string, unknown> => {
        const parsed: unknown = JSON.parse(text)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
      })
      .catch(() => ({}))
    return this.loading
  }

  async get(key: string): Promise<unknown> {
    return (await this.load())[key]
  }

  async set(key: string, value: unknown): Promise<void> {
    const data = await this.load()
    data[key] = value
    // One write at a time, in order, so two quick sets cannot interleave.
    this.queue = this.queue.then(async () => {
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      await writeFile(tmp, JSON.stringify(data), 'utf8')
      await rename(tmp, this.path)
    })
    await this.queue
  }
}

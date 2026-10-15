// What the core needs from whoever hosts it. Each outlet supplies these: the Claude pane from the
// mod engine's process, HTTP and store calls, an app from Node's child_process, fetch and a file.
// The core never reaches for a host API itself, which is what keeps it usable everywhere.

/** Runs `gh` (or makes a plain HTTP call when no `gh` is available). */
export type IO = {
  run: (
    argv: readonly string[],
    init?: { timeoutMs?: number },
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>
  fetch: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{ status: number; ok: boolean; text: string }>
}

/** How the core talks to GitHub: through the `gh` CLI (no token handled here) or with a token. */
export type Access = { source: 'gh' | 'token'; token: string }

/** Where data that should outlive a session is kept (the mod's store, a file, local storage). */
export type Store = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
}

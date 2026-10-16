// Auto-fix sends a prompt that starts a turn, and every open Claude session loads this plugin and
// sees the same failed build. Without a shared decision on who acts, each session prompts itself and
// they all start the same investigation at once (and spend the same usage). The plugin's store is the
// one thing the sessions share, so a prompt is only sent by the session that holds the claim on it.

/** The slice of the plugin store a claim needs. */
export type ClaimStore = {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  keys: () => Promise<string[]>
}

export const CLAIM_PREFIX = 'shipwatch:fix:'

/** How long a claim is remembered: what the limit counts over, and when a claim is dropped from the store. */
export const CLAIM_WINDOW_MS = 24 * 3_600_000
/** After a fix prompt for a repo, no other commit of it gets one for this long. */
export const REPO_COOLDOWN_MS = 3_600_000
/** How long to wait, after writing a claim, before reading it back to see who won. */
export const SETTLE_MS = 2_000

type Claim = { by: string; at: number; repo: string }

export type ClaimResult = 'won' | 'lost' | 'duplicate' | 'cooldown' | 'limit'

export type ClaimInput = {
  repo: string
  commit: string
  /** This session's id: what tells its claim from another session's. */
  session: string
  now: number
  /** Most claims inside the window, across every session. */
  limit: number
  wait: (ms: number) => Promise<void>
  settleMs?: number
}

const isClaim = (v: unknown): v is Claim => {
  if (!v || typeof v !== 'object') return false
  const c = v as Record<string, unknown>
  return typeof c.by === 'string' && typeof c.at === 'number' && typeof c.repo === 'string'
}

const claimKey = (repo: string, commit: string): string => `${CLAIM_PREFIX}${repo}:${commit}`

/**
 * Decides whether this session is the one to send the fix prompt for `repo` at `commit`.
 *
 * Each claim is its own store key, so two sessions claiming different commits never overwrite each
 * other. The store has no compare-and-set, so sessions that claim the same commit at the same moment all
 * write it, the last write stands, and after `settleMs` each reads it back: only the session whose id is
 * in it goes on. If a write is lost to another process, no session wins and no prompt is sent, which is
 * the safe way to fail.
 */
export const claimFix = async (store: ClaimStore, input: ClaimInput): Promise<ClaimResult> => {
  const key = claimKey(input.repo, input.commit)
  const claims = new Map<string, Claim>()
  for (const k of await store.keys()) {
    if (!k.startsWith(CLAIM_PREFIX)) continue
    const value = await store.get(k)
    if (!isClaim(value) || input.now - value.at > CLAIM_WINDOW_MS) {
      await store.delete(k)
      continue
    }
    claims.set(k, value)
  }

  if (claims.has(key)) return 'duplicate'
  for (const c of claims.values()) if (c.repo === input.repo && input.now - c.at < REPO_COOLDOWN_MS) return 'cooldown'
  if (claims.size >= input.limit) return 'limit'

  await store.set(key, { by: input.session, at: input.now, repo: input.repo } satisfies Claim)
  await input.wait(input.settleMs ?? SETTLE_MS)
  const standing = await store.get(key)
  return isClaim(standing) && standing.by === input.session ? 'won' : 'lost'
}

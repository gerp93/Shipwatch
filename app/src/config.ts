// The app's settings: an optional config.json in the user-data folder, and GITHUB_TOKEN from the environment
// (a token is never written to disk by the app). Everything has a default, so the app starts with no file.

export type AppConfig = {
  /** Account or org to show; empty means the signed-in user. */
  owner: string
  token: string
  includeForks: boolean
  /** Most recently pushed repos read (1-100). */
  count: number
  /** Days with nothing moving before a repo is called stale. */
  staleDays: number
  /** Extra names to count as AI when attributing commits. */
  aiNames: string[]
  /** Repo names to leave out. */
  ignore: string[]
}

const asString = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const asNumber = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim()) : [])

/** Settings from the parsed contents of config.json (anything, including nothing) and the environment. */
export const readConfig = (file: unknown, env: Record<string, string | undefined>): AppConfig => {
  const f = file && typeof file === 'object' ? (file as Record<string, unknown>) : {}
  return {
    owner: asString(env.SHIPWATCH_OWNER) || asString(f.owner),
    token: asString(env.GITHUB_TOKEN),
    includeForks: f.includeForks === true,
    count: Math.min(100, Math.max(1, Math.round(asNumber(f.maxRepos, 40)))),
    staleDays: Math.max(1, asNumber(f.staleDays, 14)),
    aiNames: asStrings(f.aiNames),
    ignore: asStrings(f.ignore),
  }
}

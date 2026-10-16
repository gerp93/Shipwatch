import type { PrSummary, RepoCreated, StatsMode } from './types'

// ---- Who a commit is attributed to ---------------------------------------------------------------
//
// Claude Code, Cursor and Copilot all commit and open PRs under the person's own GitHub account, so
// "who opened it" says nothing. What does is each commit's identity: its author (`claude`, `Copilot`,
// `cursoragent`...) and its `Co-Authored-By` trailers, which GitHub also reads into `authors`. A commit
// is attributed to the AI named in either place, else to the person if they authored it. New agents
// need no list: a known family is named by it, an unknown bot account is named by its own login, and
// the `aiNames` option adds any other name to match.

export const YOU = 'You'
export const OTHERS = 'Others'
export const AUTOMATION = 'Automation'
export const ALL_AI = 'AI'
/** An individual human other than you is stored as `@` and their login (or name), so they can be told apart. */
export const HUMAN_PREFIX = '@'

type Ident = { name?: string | null; email?: string | null; user?: { login?: string | null } | null }

export type RawCommit = {
  message?: string | null
  additions?: number
  deletions?: number
  parents?: { totalCount?: number }
  author?: Ident | null
  authors?: { nodes?: Array<Ident | null> }
}

export type RawMergedPr = {
  id: string
  mergedAt: string
  repository: { name: string }
  commits?: { nodes?: Array<{ commit?: RawCommit | null } | null> }
}

const FAMILIES: Array<[RegExp, string]> = [
  [/\bclaude\b|anthropic/i, 'Claude'],
  [/copilot/i, 'Copilot'],
  [/\bcursor\b|cursoragent/i, 'Cursor'],
  [/\bcodex\b|openai|chatgpt/i, 'Codex'],
  [/gemini|google-labs-jules/i, 'Gemini'],
  [/devin-ai/i, 'Devin'],
  [/\baider\b/i, 'Aider'],
  [/windsurf|codeium/i, 'Windsurf'],
]

/** Accounts that automate chores rather than write code; kept out of both "You" and "AI". */
const AUTOMATION_ACCOUNTS = /dependabot|renovate|github-actions|web-flow|imgbot|pre-commit-ci|snyk|greenkeeper/i

const identityText = (id: Ident | null | undefined): string => [id?.user?.login, id?.name, id?.email].filter(Boolean).join(' ')

const titleCase = (s: string): string => s.replace(/\b\w/g, c => c.toUpperCase())

/** `Co-Authored-By: Name <email>` lines in a commit message. */
export const trailersOf = (message: string | null | undefined): Ident[] => {
  const out: Ident[] = []
  const re = /^co-authored-by:\s*(.*?)\s*<([^>]*)>/gim
  for (let m = re.exec(message ?? ''); m; m = re.exec(message ?? '')) out.push({ name: m[1], email: m[2] })
  return out
}

/** The AI an identity belongs to, or undefined if it is not one. `extra` are further names to treat as AI. */
export const aiFamilyOf = (id: Ident | null | undefined, extra: readonly string[] = []): string | undefined => {
  const text = identityText(id)
  if (!text) return undefined
  for (const [pattern, family] of FAMILIES) if (pattern.test(text)) return family
  for (const name of extra) if (name && text.toLowerCase().includes(name.toLowerCase())) return titleCase(name)
  const login = id?.user?.login ?? ''
  if (/\[bot\]$/i.test(login) || /\[bot\]/i.test(id?.name ?? '')) {
    if (AUTOMATION_ACCOUNTS.test(text)) return undefined
    return titleCase(login.replace(/\[bot\]$/i, '') || (id?.name ?? '').replace(/\[bot\]/i, '').trim())
  }
  return undefined
}

/** Whether an actor key is an individual human other than you. */
export const isHuman = (actor: string): boolean => actor.startsWith(HUMAN_PREFIX)

/** Who one (non-merge) commit is attributed to: an AI name, YOU, AUTOMATION, or another human (`@login`, else OTHERS). */
export const actorOf = (commit: RawCommit, you: string, extra: readonly string[] = []): string => {
  const identities = [commit.author, ...(commit.authors?.nodes ?? []), ...trailersOf(commit.message)]
  for (const id of identities) {
    const family = aiFamilyOf(id, extra)
    if (family) return family
  }
  const login = commit.author?.user?.login
  if (login && you && login.toLowerCase() === you.toLowerCase()) return YOU
  if (AUTOMATION_ACCOUNTS.test(identityText(commit.author))) return AUTOMATION
  const who = (login || commit.author?.name || commit.author?.email || '').trim()
  return who ? HUMAN_PREFIX + who : OTHERS
}

export const isAi = (actor: string): boolean => actor !== YOU && actor !== OTHERS && actor !== AUTOMATION && !isHuman(actor)

/**
 * What an actor is called on screen. `Others` is the stored key (kept so saved history stays valid), but it
 * means humans other than you, not other AIs, and the screen says so; an individual is called by their login.
 */
export const actorLabel = (actor: string): string => (actor === OTHERS ? 'Other humans' : isHuman(actor) ? actor.slice(HUMAN_PREFIX.length) : actor)

/** A merged PR boiled down to what the stats need, so it can be kept and never fetched again. */
export const summarizePr = (raw: RawMergedPr, you: string, extra: readonly string[] = []): PrSummary => {
  const by: PrSummary['by'] = {}
  for (const node of raw.commits?.nodes ?? []) {
    const commit = node?.commit
    if (!commit || (commit.parents?.totalCount ?? 1) > 1) continue // a merge commit is no one's work
    const actor = actorOf(commit, you, extra)
    const [c, a, d] = by[actor] ?? [0, 0, 0]
    by[actor] = [c + 1, a + (commit.additions ?? 0), d + (commit.deletions ?? 0)]
  }
  return { id: raw.id, repo: raw.repository.name, mergedAt: raw.mergedAt, by }
}

// ---- Totals for a range and a choice of who to compare -------------------------------------------

export type Totals = { prs: number; commits: number; adds: number; dels: number }

export type Aggregate = {
  /** Merged PRs in view (those with at least one commit from an actor that is shown). */
  prs: number
  /** Per actor: the PRs wholly theirs, and their commits and changed lines. `Mixed` PRs are counted under MIXED. */
  actors: Array<{ actor: string } & Totals>
  /** PRs with commits from more than one actor. */
  mixed: number
  repos: Array<{ repo: string; prs: number; actors: Array<{ actor: string } & Totals> }>
  weeks: Array<{ start: string; prs: Record<string, number> }>
  /** Commits per actor for each day (UTC) a PR in view merged, oldest first. A commit counts on its PR's merge day. */
  days: Array<{ date: string; commits: Record<string, number> }>
}

export const MIXED = 'Mixed'

const DAY_MS = 86_400_000

/** The Monday (UTC) starting the week an instant falls in, as YYYY-MM-DD. */
export const weekStart = (iso: string): string => {
  const t = Date.parse(iso)
  const day = (new Date(t).getUTCDay() + 6) % 7
  return new Date(t - day * DAY_MS).toISOString().slice(0, 10)
}

const ORDER = (actor: string): number => (actor === YOU ? 0 : isAi(actor) || actor === ALL_AI ? 1 : actor === OTHERS || isHuman(actor) ? 2 : 3)

/**
 * What an actor is called in the chosen view: AI actors fold into one `AI` when `mode` is combined, and
 * other humans into one `Others` when `humans` is; `hidden` AIs and humans vanish.
 */
const shown = (actor: string, mode: StatsMode, humans: StatsMode, hidden: ReadonlySet<string>): string | null => {
  if (actor === AUTOMATION) return null
  if (isHuman(actor)) return hidden.has(actor) ? null : humans === 'combined' ? OTHERS : actor
  if (!isAi(actor)) return actor
  if (hidden.has(actor)) return null
  return mode === 'combined' ? ALL_AI : actor
}

export const aggregate = (
  prs: readonly PrSummary[],
  sinceMs: number,
  mode: StatsMode,
  hidden: readonly string[] = [],
  humans: StatsMode = 'combined',
): Aggregate => {
  const hide = new Set(hidden)
  const actorTotals = new Map<string, Totals>()
  const repoMap = new Map<string, { prs: number; actors: Map<string, Totals> }>()
  const weekMap = new Map<string, Record<string, number>>()
  const dayMap = new Map<string, Record<string, number>>()
  let inView = 0
  let mixed = 0

  const add = (map: Map<string, Totals>, actor: string, c: number, a: number, d: number, pr: number) => {
    const t = map.get(actor) ?? { prs: 0, commits: 0, adds: 0, dels: 0 }
    t.prs += pr
    t.commits += c
    t.adds += a
    t.dels += d
    map.set(actor, t)
  }

  for (const pr of prs) {
    if (Date.parse(pr.mergedAt) < sinceMs) continue
    // Fold this PR's commits into the actors the view shows.
    const folded = new Map<string, [number, number, number]>()
    for (const [actor, [c, a, d]] of Object.entries(pr.by)) {
      const name = shown(actor, mode, humans, hide)
      if (!name) continue
      const [fc, fa, fd] = folded.get(name) ?? [0, 0, 0]
      folded.set(name, [fc + c, fa + a, fd + d])
    }
    if (folded.size === 0) continue
    inView += 1
    const label = folded.size === 1 ? [...folded.keys()][0]! : MIXED
    if (label === MIXED) mixed += 1

    const repo = repoMap.get(pr.repo) ?? { prs: 0, actors: new Map<string, Totals>() }
    repo.prs += 1
    repoMap.set(pr.repo, repo)
    for (const [actor, [c, a, d]] of folded) {
      // A PR counts once, for the actor who owns it whole; a mixed one counts for no single actor.
      const own = label === actor ? 1 : 0
      add(actorTotals, actor, c, a, d, own)
      add(repo.actors, actor, c, a, d, own)
    }
    const week = weekMap.get(weekStart(pr.mergedAt)) ?? {}
    week[label] = (week[label] ?? 0) + 1
    weekMap.set(weekStart(pr.mergedAt), week)
    const date = pr.mergedAt.slice(0, 10)
    const day = dayMap.get(date) ?? {}
    for (const [actor, [c]] of folded) day[actor] = (day[actor] ?? 0) + c
    dayMap.set(date, day)
  }

  const actors = (map: Map<string, Totals>) =>
    [...map.entries()]
      .map(([actor, t]) => ({ actor, ...t }))
      .sort((x, y) => ORDER(x.actor) - ORDER(y.actor) || y.commits - x.commits)

  return {
    prs: inView,
    mixed,
    actors: actors(actorTotals),
    repos: [...repoMap.entries()]
      .map(([repo, r]) => ({ repo, prs: r.prs, actors: actors(r.actors) }))
      .sort((x, y) => y.prs - x.prs),
    weeks: [...weekMap.entries()].map(([start, prs]) => ({ start, prs })).sort((x, y) => x.start.localeCompare(y.start)),
    days: [...dayMap.entries()].map(([date, commits]) => ({ date, commits })).sort((x, y) => x.date.localeCompare(y.date)),
  }
}

export type Bucket = 'day' | 'week' | 'month'

/** How coarsely to chart a range so the line has enough points to read and not so many it is noise. */
export const bucketFor = (spanDays: number): Bucket => (spanDays <= 45 ? 'day' : spanDays <= 200 ? 'week' : 'month')

/**
 * Commits per actor over time as aligned series, one value per bucket from `fromMs` to `toMs` with empty
 * buckets as zero, so a quiet stretch shows as a dip and not a gap. Buckets are UTC days, Monday-start
 * weeks, or calendar months. Labels are the bucket's first date (`YYYY-MM-DD`, or `YYYY-MM` for a month).
 */
export const commitSeries = (
  days: Aggregate['days'],
  actors: readonly string[],
  bucket: Bucket,
  fromMs: number,
  toMs: number,
): { labels: string[]; values: Record<string, number[]> } => {
  const keyOf = (date: string): string => (bucket === 'day' ? date : bucket === 'week' ? weekStart(`${date}T00:00:00Z`) : date.slice(0, 7))
  const labels: string[] = []
  if (bucket === 'month') {
    const from = new Date(fromMs)
    const to = new Date(toMs)
    for (let y = from.getUTCFullYear(), m = from.getUTCMonth(); y < to.getUTCFullYear() || (y === to.getUTCFullYear() && m <= to.getUTCMonth()); ) {
      labels.push(`${y}-${String(m + 1).padStart(2, '0')}`)
      if (++m > 11) (m = 0), y++
    }
  } else {
    const step = bucket === 'day' ? DAY_MS : 7 * DAY_MS
    const first = bucket === 'day' ? dayMs(dateOf(fromMs)) : dayMs(weekStart(new Date(fromMs).toISOString()))
    for (let t = first; t <= toMs; t += step) labels.push(dateOf(t))
  }
  const index = new Map(labels.map((l, i) => [l, i] as const))
  const values: Record<string, number[]> = Object.fromEntries(actors.map(a => [a, labels.map(() => 0)]))
  for (const d of days) {
    const i = index.get(keyOf(d.date))
    if (i === undefined) continue
    for (const [actor, c] of Object.entries(d.commits)) if (values[actor]) values[actor]![i]! += c
  }
  return { labels, values }
}

/** Every AI named anywhere in the PRs (so each can get its own switch), most active first. */
export const aisIn = (prs: readonly PrSummary[]): string[] => {
  const commits = new Map<string, number>()
  for (const pr of prs) for (const [actor, [c]] of Object.entries(pr.by)) if (isAi(actor)) commits.set(actor, (commits.get(actor) ?? 0) + c)
  return [...commits.entries()].sort((a, b) => b[1] - a[1]).map(([actor]) => actor)
}

/** Every individual human other than you named in the PRs (so each can get its own switch), most active first. */
export const humansIn = (prs: readonly PrSummary[]): string[] => {
  const commits = new Map<string, number>()
  for (const pr of prs) for (const [actor, [c]] of Object.entries(pr.by)) if (isHuman(actor)) commits.set(actor, (commits.get(actor) ?? 0) + c)
  return [...commits.entries()].sort((a, b) => b[1] - a[1]).map(([actor]) => actor)
}

/** Repos created since `sinceMs`, newest first. Forks are left out unless asked for; archived ones count. */
export const reposCreatedSince = (repos: readonly RepoCreated[], sinceMs: number, includeForks = false): RepoCreated[] =>
  repos
    .filter(r => Date.parse(r.createdAt) >= sinceMs && (includeForks || !r.isFork))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

// ---- Drawing helpers ----------------------------------------------------------------------------------

/** Splits `width` cells between parts in proportion to their values; a part with any value gets at least one. */
export const barCells = (values: readonly number[], width: number): number[] => {
  const total = values.reduce((a, b) => a + b, 0)
  if (total <= 0 || width <= 0) return values.map(() => 0)
  const raw = values.map(v => (v / total) * width)
  const cells = raw.map((r, i) => (values[i]! > 0 ? Math.max(1, Math.floor(r)) : 0))
  let spare = width - cells.reduce((a, b) => a + b, 0)
  const byRemainder = raw.map((r, i) => [r - Math.floor(r), i] as const).sort((a, b) => b[0] - a[0])
  for (let k = 0; spare > 0 && k < 1000; k++) {
    const [, i] = byRemainder[k % byRemainder.length]!
    if (values[i]! > 0) {
      cells[i]! += 1
      spare -= 1
    }
  }
  // Over-allocated by the one-cell minimum: take it back from the widest part.
  while (spare < 0) {
    const widest = cells.indexOf(Math.max(...cells))
    cells[widest]! -= 1
    spare += 1
  }
  return cells
}

/** `1234` -> `1,234`; `51200` -> `51.2k`; `1500000` -> `1.5M`. */
export const compact = (n: number): string => {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** The ranges the Stats view offers, in days. `ALL_TIME` (0) reaches back to the first repo. */
export const ALL_TIME = 0
export const RANGES = [7, 30, 90, 180, 365, 730, 1825, ALL_TIME] as const

/** What a range button says. Years are counted back from today, not calendar years. */
export const rangeLabel = (days: number): string =>
  days === ALL_TIME ? 'All time' : days === 730 ? '2 years' : days === 1825 ? '5 years' : `${days} days`

export const sinceFor = (days: number, now: number): number => now - days * DAY_MS

/**
 * Where a range starts. `ALL_TIME` starts at the earliest thing known (the oldest repo, or failing that the
 * oldest merged PR held), so it never means "from 1970" and never asks GitHub for years with nothing in them.
 */
export const rangeSince = (days: number, now: number, earliestMs: number | undefined): number =>
  days === ALL_TIME ? Math.min(now, earliestMs ?? now - 365 * DAY_MS) : sinceFor(days, now)

/** The earliest creation or merge date held, as epoch ms; undefined when nothing is held yet. */
export const earliestKnown = (repos: readonly RepoCreated[], prs: readonly PrSummary[]): number | undefined => {
  const times = [...repos.map(r => Date.parse(r.createdAt)), ...prs.map(p => Date.parse(p.mergedAt))].filter(Number.isFinite)
  return times.length > 0 ? Math.min(...times) : undefined
}

// ---- Which dates still need fetching ----------------------------------------------------------------------

/** YYYY-MM-DD (UTC) of an instant. */
export const dateOf = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

const dayMs = (date: string): number => Date.parse(`${date}T00:00:00Z`)

/** Inclusive date windows of at most `chunkDays` days covering `fromMs` to `toMs`. */
export const windowsBetween = (fromMs: number, toMs: number, chunkDays = 30): Array<{ from: string; to: string }> => {
  const out: Array<{ from: string; to: string }> = []
  const last = dayMs(dateOf(toMs))
  for (let start = dayMs(dateOf(fromMs)); start <= last; ) {
    const end = Math.min(start + (chunkDays - 1) * DAY_MS, last)
    out.push({ from: dateOf(start), to: dateOf(end) })
    start = end + DAY_MS
  }
  return out
}

/**
 * What to fetch so merged PRs from `sinceMs` to now are all held, given what already is: the days before
 * the held history (if the range reaches further back) and the days since it ended. History is held up to
 * yesterday only - today is still filling - so today is fetched again each time and merged by PR id.
 */
export const planFetch = (
  coveredFrom: string,
  coveredThrough: string,
  nowMs: number,
  sinceMs: number,
): { windows: Array<{ from: string; to: string }>; coveredFrom: string; coveredThrough: string } => {
  const yesterday = dateOf(nowMs - DAY_MS)
  const wantFrom = dateOf(sinceMs)
  if (!coveredFrom || !coveredThrough) {
    return { windows: windowsBetween(dayMs(wantFrom), nowMs), coveredFrom: wantFrom, coveredThrough: yesterday }
  }
  const windows: Array<{ from: string; to: string }> = []
  let from = coveredFrom
  if (wantFrom < coveredFrom) {
    windows.push(...windowsBetween(dayMs(wantFrom), dayMs(coveredFrom) - DAY_MS))
    from = wantFrom
  }
  windows.push(...windowsBetween(dayMs(coveredThrough) + DAY_MS, nowMs))
  return { windows, coveredFrom: from, coveredThrough: yesterday }
}

/** `prs` with `added` folded in, a PR already held replaced by its newer copy. */
export const mergeById = (prs: readonly PrSummary[], added: readonly PrSummary[]): PrSummary[] => {
  const map = new Map(prs.map(p => [p.id, p] as const))
  for (const p of added) map.set(p.id, p)
  return [...map.values()]
}

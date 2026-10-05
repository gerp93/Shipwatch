import type { Checks, Level, PrView, RepoView, StepState } from '../types'

/** The slice of GitHub's GraphQL answer this mod reads (see github.ts QUERY). */
export type RawRollup = { state?: string } | null | undefined

export type RawPr = {
  number: number
  title: string
  url: string
  isDraft: boolean
  headRefName: string
  updatedAt: string
  mergeable?: string
  commits?: { nodes?: Array<{ commit?: { statusCheckRollup?: RawRollup } }> }
}

export type RawRepo = {
  name: string
  url: string
  isArchived: boolean
  isFork: boolean
  pushedAt: string
  defaultBranchRef?: {
    name: string
    target?: { oid?: string; committedDate?: string; statusCheckRollup?: RawRollup }
  } | null
  latestRelease?: { tagName: string; publishedAt: string } | null
  pullRequests?: { nodes?: RawPr[] }
}

type Steps = RepoView['steps']

export const checksOf = (rollup: RawRollup): Checks => {
  switch (rollup?.state) {
    case 'SUCCESS':
      return 'passing'
    case 'PENDING':
    case 'EXPECTED':
      return 'running'
    case 'FAILURE':
    case 'ERROR':
      return 'failing'
    default:
      return 'none'
  }
}

const prView = (pr: RawPr): PrView => ({
  number: pr.number,
  title: pr.title,
  url: pr.url,
  branch: pr.headRefName,
  isDraft: pr.isDraft,
  hasConflict: pr.mergeable === 'CONFLICTING',
  checks: checksOf(pr.commits?.nodes?.[0]?.commit?.statusCheckRollup),
  updatedAt: pr.updatedAt,
})

/** Lower is more urgent; the PR that decides where the repo sits in the stepper. */
const weight = (pr: PrView): number => {
  if (pr.checks === 'failing' || pr.hasConflict) return 0
  if (pr.checks === 'running') return 1
  return pr.isDraft ? 3 : 2
}

const steps = (...s: StepState[]): Steps => s as Steps

/**
 * Where a repo is in the iteration: PR -> Build -> Merged -> Released.
 *
 * With an open PR the stepper follows the most urgent PR. With none it follows
 * the default branch: its head build, then whether a release has caught up with
 * the head commit. `recentMs` is how long after a merge a missing release still
 * counts as "awaiting" rather than "this repo just doesn't release every commit".
 */
const classify = (raw: RawRepo, now: number, recentMs: number): RepoView => {
  const target = raw.defaultBranchRef?.target
  const headChecks = checksOf(target?.statusCheckRollup)
  const headDate = target?.committedDate ?? ''
  const release = raw.latestRelease
    ? { tag: raw.latestRelease.tagName, publishedAt: raw.latestRelease.publishedAt }
    : null
  const prs = (raw.pullRequests?.nodes ?? []).map(prView).sort((a, b) => weight(a) - weight(b))

  const base = {
    name: raw.name,
    url: raw.url,
    pushedAt: raw.pushedAt,
    headChecks,
    headDate,
    release,
    prs,
    activity: [] as string[],
    isStale: false,
  }

  const pr = prs[0]
  if (pr) {
    const n = `#${pr.number}`
    if (pr.hasConflict) {
      return { ...base, steps: steps('done', 'todo', 'todo', 'todo'), level: 'fail', headline: `${n} has merge conflicts` }
    }
    if (pr.checks === 'failing') {
      return { ...base, steps: steps('done', 'failed', 'todo', 'todo'), level: 'fail', headline: `${n} build failing` }
    }
    if (pr.checks === 'running') {
      return { ...base, steps: steps('done', 'running', 'todo', 'todo'), level: 'running', headline: `${n} building` }
    }
    if (pr.isDraft) {
      return { ...base, steps: steps('done', 'todo', 'todo', 'todo'), level: 'pending', headline: `${n} draft` }
    }
    const built: StepState = pr.checks === 'passing' ? 'done' : 'todo'
    return {
      ...base,
      steps: steps('done', built, 'todo', 'todo'),
      level: 'ready',
      headline: pr.checks === 'passing' ? `${n} ready to merge` : `${n} open, no checks`,
    }
  }

  if (!target) {
    return { ...base, steps: steps('todo', 'todo', 'todo', 'todo'), level: 'idle', headline: 'no commits yet' }
  }
  if (headChecks === 'running') {
    return { ...base, steps: steps('done', 'done', 'done', 'running'), level: 'running', headline: 'building main' }
  }
  if (headChecks === 'failing') {
    return { ...base, steps: steps('done', 'done', 'done', 'failed'), level: 'fail', headline: 'main build failing' }
  }
  if (!release) {
    return { ...base, steps: steps('done', 'done', 'done', 'todo'), level: 'idle', headline: 'no releases' }
  }
  const isReleased = Date.parse(release.publishedAt) >= Date.parse(headDate)
  if (isReleased) {
    return { ...base, steps: steps('done', 'done', 'done', 'done'), level: 'idle', headline: `up to date · ${release.tag}` }
  }
  const isRecent = now - Date.parse(headDate) < recentMs
  return {
    ...base,
    steps: steps('done', 'done', 'done', isRecent ? 'running' : 'todo'),
    level: isRecent ? 'pending' : 'idle',
    headline: isRecent ? `awaiting release · last ${release.tag}` : `unreleased commits · last ${release.tag}`,
  }
}

const DAY_MS = 86_400_000

/**
 * `classify` plus staleness: a repo nothing has touched for `staleMs` (a push, or
 * activity on one of its PRs) and that is not building is stale. Old conflicted
 * drafts would otherwise outrank the build you are actually waiting on.
 */
export const analyze = (raw: RawRepo, now: number, recentMs: number, staleMs: number = 14 * DAY_MS): RepoView => {
  const view = classify(raw, now, recentMs)
  const touched = Math.max(
    Date.parse(raw.pushedAt) || 0,
    ...(raw.pullRequests?.nodes ?? []).map(p => Date.parse(p.updatedAt) || 0),
  )
  return { ...view, isStale: view.level !== 'running' && now - touched > staleMs }
}

const URGENCY: Record<Level, number> = { fail: 0, running: 1, ready: 2, pending: 3, idle: 4 }

/** Attention first; within a level, most recently pushed first. */
export const byUrgency = (a: RepoView, b: RepoView): number =>
  URGENCY[a.level] - URGENCY[b.level] || Date.parse(b.pushedAt) - Date.parse(a.pushedAt)

/** What each repo looked like at the last poll, to spot transitions. */
export type Seen = Record<string, { head: Checks; prs: Record<number, Checks>; tag: string | null }>

export const snapshot = (repos: readonly RepoView[]): Seen => {
  const seen: Seen = {}
  for (const r of repos) {
    seen[r.name] = {
      head: r.headChecks,
      prs: Object.fromEntries(r.prs.map(p => [p.number, p.checks])),
      tag: r.release?.tag ?? null,
    }
  }
  return seen
}

/** Toast lines for what changed since `before`; empty on the first poll (`before` empty). */
export const transitions = (before: Seen, repos: readonly RepoView[]): string[] => {
  if (Object.keys(before).length === 0) return []
  const out: string[] = []
  const settled = (was: Checks | undefined, now: Checks, label: string) => {
    if (was !== 'running') return
    if (now === 'passing') out.push(`✓ ${label} build passed`)
    else if (now === 'failing') out.push(`✗ ${label} build failed`)
  }
  for (const r of repos) {
    const was = before[r.name]
    if (!was) continue
    settled(was.head, r.headChecks, `${r.name} main`)
    for (const p of r.prs) settled(was.prs[p.number], p.checks, `${r.name} #${p.number}`)
    if (was.tag && r.release && r.release.tag !== was.tag) {
      out.push(`⬆ ${r.name} ${r.release.tag} released — ready to download`)
    }
  }
  return out
}

/** Short relative age: `now`, `5m`, `3h`, `2d`. */
export const ago = (iso: string, now: number): string => {
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms)) return ''
  const min = Math.floor(ms / 60000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  return hr < 24 ? `${hr}h` : `${Math.floor(hr / 24)}d`
}

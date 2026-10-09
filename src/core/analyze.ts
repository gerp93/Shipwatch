import type { Checks, Level, PrView, RepoView, StepState } from './types'

/** One check on a commit: a check run (`status`, `conclusion`) or a legacy commit status (`state`). */
export type RawContext = { status?: string; conclusion?: string | null; state?: string } | null

/** The slice of GitHub's GraphQL answer this mod reads (see github.ts QUERY). */
export type RawRollup = { state?: string; contexts?: { nodes?: RawContext[] } } | null | undefined

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

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])

/**
 * What a commit's checks add up to, read from the individual checks. GitHub's own combined state
 * counts a CANCELLED run (one a newer push superseded) as a failure, and a SKIPPED one as nothing,
 * so a commit whose runs were all cancelled reads FAILURE although nothing failed. Here cancelled
 * and skipped runs say nothing: only a failed or timed-out check fails, only an unfinished one runs.
 */
const fromContexts = (nodes: RawContext[]): Checks => {
  let failing = false
  let running = false
  let passing = false
  for (const n of nodes) {
    if (!n) continue
    if (n.status !== undefined) {
      if (n.status !== 'COMPLETED') running = true
      else if (n.conclusion && FAILED_CONCLUSIONS.has(n.conclusion)) failing = true
      else if (n.conclusion === 'SUCCESS' || n.conclusion === 'NEUTRAL') passing = true
    } else if (n.state === 'FAILURE' || n.state === 'ERROR') failing = true
    else if (n.state === 'PENDING' || n.state === 'EXPECTED') running = true
    else if (n.state === 'SUCCESS') passing = true
  }
  if (failing) return 'failing'
  if (running) return 'running'
  return passing ? 'passing' : 'none'
}

export const checksOf = (rollup: RawRollup): Checks => {
  const nodes = rollup?.contexts?.nodes
  if (nodes && nodes.length > 0) return fromContexts(nodes)
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

/** Lower is more urgent; the PR that decides where the repo sits in the stepper. A draft is work in
 * progress, so it never outranks a real PR however its checks look. */
const weight = (pr: PrView): number => {
  if (pr.isDraft) return 3
  if (pr.checks === 'failing' || pr.hasConflict) return 0
  if (pr.checks === 'running') return 1
  return 2
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
    branch: raw.defaultBranchRef?.name ?? '',
    headOid: target?.oid ?? '',
    release,
    prs,
    activity: [] as RepoView['activity'],
    isStale: false,
    isInfra: false,
  }

  // Drafts come last; the stepper follows the first real PR, and only falls back to a draft below.
  const pr = prs.find(p => !p.isDraft)
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
  // Only drafts are open. They are still shown, but quietly: the default branch's own state matters more.
  const draft = prs[0]
  const draftView = (): RepoView => ({
    ...base,
    steps: steps('done', 'todo', 'todo', 'todo'),
    level: 'draft',
    headline: prs.length === 1 ? `#${draft!.number} draft` : `${prs.length} draft PRs`,
  })
  if (headChecks === 'running') {
    return { ...base, steps: steps('done', 'done', 'done', 'running'), level: 'running', headline: 'building main' }
  }
  if (headChecks === 'failing') {
    return { ...base, steps: steps('done', 'done', 'done', 'failed'), level: 'fail', headline: 'main build failing' }
  }
  if (!release) {
    return draft ? draftView() : { ...base, steps: steps('done', 'done', 'done', 'todo'), level: 'idle', headline: 'no releases' }
  }
  const isReleased = Date.parse(release.publishedAt) >= Date.parse(headDate)
  if (isReleased) {
    return draft
      ? draftView()
      : { ...base, steps: steps('done', 'done', 'done', 'done'), level: 'idle', headline: `up to date · ${release.tag}` }
  }
  const isRecent = now - Date.parse(headDate) < recentMs
  if (!isRecent && draft) return draftView()
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

const URGENCY: Record<Level, number> = { fail: 0, running: 1, ready: 2, pending: 3, draft: 4, idle: 5 }

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
    // A draft's checks are no one's to-do, so they are not announced.
    for (const p of r.prs) if (!p.isDraft) settled(was.prs[p.number], p.checks, `${r.name} #${p.number}`)
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

/** Repos whose default-branch build went from running to failing since `before`. */
export const failedOnMain = (before: Seen, repos: readonly RepoView[]): RepoView[] =>
  Object.keys(before).length === 0
    ? []
    : repos.filter(r => before[r.name]?.head === 'running' && r.headChecks === 'failing' && !r.isInfra)

// Names the fix prompt interpolates come from GitHub and are controlled by whoever
// owns the repo (a branch name can hold nearly anything), so only plain ones are
// allowed through: anything else gets no auto-fix prompt rather than a sanitized one.
const SAFE_OWNER = /^[A-Za-z0-9-]{1,39}$/
const SAFE_REPO = /^[A-Za-z0-9._-]{1,100}$/
const SAFE_BRANCH = /^[A-Za-z0-9._/-]{1,100}$/
const SAFE_OID = /^[0-9a-f]{7,64}$/

/**
 * The prompt that wakes a session to look into a broken default-branch build, or
 * null when the owner, repo, branch or commit id holds anything beyond plain
 * name characters.
 */
export const fixPrompt = (owner: string, r: RepoView): string | null => {
  if (!SAFE_OWNER.test(owner) || !SAFE_REPO.test(r.name) || !SAFE_BRANCH.test(r.branch) || !SAFE_OID.test(r.headOid)) {
    return null
  }
  return [
    `Shipwatch: the build on ${r.branch} just failed in ${owner}/${r.name} (commit ${r.headOid.slice(0, 7)}).`,
    'Do this once, then stop:',
    `1. Find the failing run: \`gh run list -R ${owner}/${r.name} --branch ${r.branch} --limit 3\`, then \`gh run view <id> -R ${owner}/${r.name} --log-failed\`.`,
    '2. Decide the cause. If it is a flaky test, an outage, or something outside the code (secrets, quota, runner), do not change code: tell me what it is.',
    `3. Otherwise fix it in a local clone of the repo (look next to the current project; else \`gh repo clone\`), on a new branch. Never push to ${r.branch}. Open a PR following my usual PR rules.`,
    '4. If you cannot tell what broke, say so instead of guessing.',
  ].join('\n')
}

// Annotation text GitHub puts on a check run that failed for its own reasons.
const INFRA_PATTERNS = [
  /not acquired by Runner/i,
  /hosted runner lost communication/i,
  /runner has received a shutdown signal/i,
]

/** Whether a check-run annotation says GitHub, not the code, failed the job. */
export const isInfraMessage = (message: string): boolean => INFRA_PATTERNS.some(p => p.test(message))

/** `view` re-labelled as an infrastructure failure when its main build failed for that reason. */
export const markInfra = (view: RepoView, isInfra: boolean): RepoView =>
  isInfra && view.level === 'fail' && view.headline === 'main build failing'
    ? { ...view, isInfra: true, headline: 'main CI never ran (GitHub runner outage)' }
    : view

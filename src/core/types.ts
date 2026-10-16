// The shapes Shipwatch's core works in. Pure types: nothing here knows about Claude Code, Node or a
// browser, so every outlet (the Claude pane, a web report, an app) shares them.

export type Checks = 'passing' | 'running' | 'failing' | 'none'

/** One stepper position: done, in progress, failed, or not reached. */
export type StepState = 'done' | 'running' | 'failed' | 'todo'

/**
 * How much attention a repo needs, most urgent first. `recent` is nothing to act on, but its default branch was
 * updated in the last few days; `idle` (shown as Quiet) is nothing to act on and nothing updated for several days.
 */
export type Level = 'fail' | 'running' | 'ready' | 'pending' | 'recent' | 'draft' | 'idle'

/**
 * A PR opened recently and where it stands now, open, merged or closed: what the ship clock puts on its dial.
 * Unlike `PrView` (open PRs only) this includes the ones already merged or closed.
 */
export type RecentPr = {
  repo: string
  number: number
  title: string
  url: string
  /** When it was opened, ISO. */
  createdAt: string
  state: 'open' | 'merged' | 'closed'
  isDraft: boolean
  /** A draft, or titled "do not merge". */
  parked: boolean
  /** The checks on its latest commit; meaningful while it is open. */
  checks: Checks
  mergedAt: string | null
}

export type PrView = {
  number: number
  title: string
  url: string
  branch: string
  isDraft: boolean
  /** A draft, or titled "do not merge": set aside, so left out of the repo's status unless asked for. */
  parked: boolean
  hasConflict: boolean
  checks: Checks
  updatedAt: string
}

export type RepoView = {
  name: string
  url: string
  pushedAt: string
  /** Checks on the default branch's head commit. */
  headChecks: Checks
  /** The default branch's head commit date, ISO; empty when the repo has no commits. */
  headDate: string
  /** The default branch's name and head commit id; empty when the repo has no commits. */
  branch: string
  headOid: string
  release: { tag: string; publishedAt: string } | null
  prs: PrView[]
  /** Workflow runs in flight: `text` is `name · branch`, `url` the run's page on GitHub (may be empty). */
  activity: Array<{ text: string; url: string }>
  /** PR, Build, Merged, Released. */
  steps: [StepState, StepState, StepState, StepState]
  level: Level
  headline: string
  /** Nothing has moved for longer than the stale cutoff and nothing is building. */
  isStale: boolean
  /** The default-branch build failed because GitHub never ran it (a runner outage), not because of the code. */
  isInfra: boolean
}

export type Board = {
  owner: string
  repos: RepoView[]
  /** Epoch ms of the last completed refresh; 0 before the first. */
  updatedAt: number
  isLoading: boolean
  error: string | null
  /** How the dashboard is being paced when it is slowed or paused for GitHub's allowance; null when it is not. */
  note: string | null
  /** GraphQL points GitHub reported left after the last read, for the header; null before the first read. */
  points: { remaining: number; limit: number; resetAt: number } | null
  /** How the last refresh reached GitHub. */
  source: 'gh' | 'token' | null
}

/** A merged PR boiled down for the stats: per actor (`You`, an AI's name, `Others`, `Automation`), its
 * commits, lines added and lines removed. Kept in the store so a merged PR is fetched only once. */
export type PrSummary = {
  id: string
  repo: string
  mergedAt: string
  by: Record<string, [commits: number, additions: number, deletions: number]>
}

export type RepoCreated = { name: string; createdAt: string; isArchived: boolean; isFork: boolean }

/** Days back from now; 0 means all time (from the first repo). */
export type StatsRange = number

export type StatsMode = 'combined' | 'separate'

export type StatsBoard = {
  /** Days back the view covers. */
  range: StatsRange
  /** `combined`: You against all AI together. `separate`: You against each AI. */
  mode: StatsMode
  /** AIs switched off, so the view compares You against only the rest. */
  hidden: string[]
  prs: PrSummary[]
  repos: RepoCreated[]
  /** The merged-PR history held, as ISO dates: everything merged from `coveredFrom` to `coveredThrough`. */
  coveredFrom: string
  coveredThrough: string
  /** The signed-in account, whose commits are `You`. */
  you: string
  isLoading: boolean
  /** What the loader is doing right now, e.g. `Loading PRs 3 of 11`. */
  progress: string
  error: string | null
  updatedAt: number
}

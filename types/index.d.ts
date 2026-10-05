export type Checks = 'passing' | 'running' | 'failing' | 'none'

/** One stepper position: done, in progress, failed, or not reached. */
export type StepState = 'done' | 'running' | 'failed' | 'todo'

/** How much attention a repo needs, most urgent first. */
export type Level = 'fail' | 'running' | 'ready' | 'pending' | 'idle'

export type PrView = {
  number: number
  title: string
  url: string
  branch: string
  isDraft: boolean
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
  release: { tag: string; publishedAt: string } | null
  prs: PrView[]
  /** Workflow runs in flight, as `name · branch`. */
  activity: string[]
  /** PR, Build, Merged, Released. */
  steps: [StepState, StepState, StepState, StepState]
  level: Level
  headline: string
  /** Nothing has moved for longer than the stale cutoff and nothing is building. */
  isStale: boolean
}

export type Board = {
  owner: string
  repos: RepoView[]
  /** Epoch ms of the last completed refresh; 0 before the first. */
  updatedAt: number
  isLoading: boolean
  error: string | null
  /** How the last refresh reached GitHub. */
  source: 'gh' | 'token' | null
}

declare module 'claude-code' {
  interface PluginState {
    'shipwatch': { board: Board; showStale: boolean }
  }
}

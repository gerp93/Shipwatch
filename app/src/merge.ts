// The Merge button on the report, from the main process's side: check what the page asked for, look at the PR
// as it is now, ask the user in a native dialog (the page cannot answer that for them), then merge. The
// decisions about what is safe are the core's (src/core/merge.ts); this file is only the hand-off.

import { connect } from '../../src/core/github'
import { doMerge, planMerge } from '../../src/core/merge'
import type { MergePlan } from '../../src/core/merge'
import type { IO } from '../../src/core/ports'

import type { AppConfig } from './config'

/** What the user is asked to confirm. */
export type Question = { title: string; detail: string; action: string }

export type MergeResult = {
  ok: boolean
  /** One line for the person: what happened, or why not. */
  message: string
  /** GitHub changed (merged, or auto-merge turned on), so the report on screen is out of date. */
  changed: boolean
}

export type MergeDeps = {
  io: IO
  config: AppConfig
  /** The account the report on screen was built for, and its open PRs as `repo#number`. */
  owner: string
  known: ReadonlySet<string>
  confirm: (question: Question) => Promise<boolean>
}

const METHOD_WORDS = { MERGE: 'a merge commit', SQUASH: 'a squash commit', REBASE: 'a rebase' } as const

/** The confirmation for a plan that is not a refusal. */
export const describePlan = (repo: string, plan: Exclude<MergePlan, { kind: 'refuse' }>): Question =>
  plan.kind === 'merge'
    ? {
        title: `Merge ${repo}#${plan.number}?`,
        detail: `${plan.title}\n\nIt is merged into its base branch now, as ${METHOD_WORDS[plan.method]}. This cannot be undone from Shipwatch.`,
        action: 'Merge',
      }
    : {
        title: `Merge ${repo}#${plan.number} when its checks pass?`,
        detail: `${plan.title}\n\nGitHub will merge it as ${METHOD_WORDS[plan.method]} once its checks and reviews allow. You can turn this off on the PR's page.`,
        action: 'Turn on auto-merge',
      }

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/

/**
 * Handles the page's request to merge `repo`#`number`. Arguments come from a web page, so they are checked: the PR
 * must be one the report on screen lists. Never throws; a problem comes back as a result to show.
 */
export const mergeFromReport = async (deps: MergeDeps, repo: unknown, number: unknown): Promise<MergeResult> => {
  const fail = (message: string): MergeResult => ({ ok: false, message, changed: false })
  if (typeof repo !== 'string' || !REPO_NAME.test(repo) || typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    return fail('That is not a pull request.')
  }
  if (!deps.known.has(`${repo}#${number}`)) return fail(`${repo}#${number} is not on this report. Refresh and try again.`)
  try {
    const access = await connect(deps.io, deps.config.token)
    const plan = await planMerge(deps.io, access, deps.owner, repo, number)
    if (plan.kind === 'refuse') return fail(plan.reason)
    if (!(await deps.confirm(describePlan(repo, plan)))) return fail('Cancelled.')
    return { ok: true, message: await doMerge(deps.io, access, plan), changed: true }
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
}

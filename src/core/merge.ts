// Merging a PR from Shipwatch: first look at the PR as it is right now, decide what is safe (merge it, turn on
// auto-merge, or refuse and say why), then carry that out. The two steps are separate so a host can show what
// is about to happen and ask before anything changes. It never bypasses branch protection or required checks:
// GitHub itself rules on those, and a refusal from GitHub comes back as the error.

import { graphql } from './github'
import { NOT_FOR_MERGE } from './parked'
import type { Access, IO } from './ports'

type Method = 'MERGE' | 'SQUASH' | 'REBASE'

/** What clicking Merge on a PR would do. */
export type MergePlan =
  | {
      /** `merge`: merge it now. `auto`: turn on auto-merge, so GitHub merges it once its requirements are met. */
      kind: 'merge' | 'auto'
      /** GitHub's id for the PR (what the mutations take), and the commit it was judged at. */
      id: string
      headOid: string
      method: Method
      number: number
      title: string
    }
  | { kind: 'refuse'; reason: string }

const PR_QUERY = `
query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){
    autoMergeAllowed mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    pullRequest(number:$n){
      id number title state isDraft mergeable mergeStateStatus headRefOid
      autoMergeRequest{ enabledAt }
      commits(last:1){ nodes{ commit{ statusCheckRollup{ state } } } }
    }
  }
}`

const MERGE_MUTATION = `
mutation($id:ID!,$method:PullRequestMergeMethod!,$oid:GitObjectID!){
  mergePullRequest(input:{pullRequestId:$id,mergeMethod:$method,expectedHeadOid:$oid}){ pullRequest{ state } }
}`

const AUTO_MUTATION = `
mutation($id:ID!,$method:PullRequestMergeMethod!){
  enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:$method}){ pullRequest{ autoMergeRequest{ enabledAt } } }
}`

const failure = (out: any, fallback: string): Error => new Error(out?.errors?.[0]?.message ?? fallback)

/** The repo's own preference first (a merge commit), else whichever method it allows. */
const methodFor = (repo: { mergeCommitAllowed?: boolean; squashMergeAllowed?: boolean; rebaseMergeAllowed?: boolean }): Method =>
  repo.mergeCommitAllowed !== false ? 'MERGE' : repo.squashMergeAllowed ? 'SQUASH' : repo.rebaseMergeAllowed ? 'REBASE' : 'MERGE'

/**
 * Reads the PR fresh from GitHub (the report may be minutes old) and decides what Merge should do:
 * - merge now, when GitHub says it is cleanly mergeable;
 * - turn on auto-merge, when it is waiting on checks or on a requirement GitHub will wait for;
 * - refuse, for a closed or draft PR, a conflict, failing checks, a branch behind its base, or anything GitHub
 *   is still working out.
 */
export const planMerge = async (io: IO, access: Access, owner: string, repo: string, number: number): Promise<MergePlan> => {
  const out = await graphql(io, access, PR_QUERY, { owner, repo, n: number })
  const r = out?.data?.repository
  const pr = r?.pullRequest
  if (!pr) throw failure(out, `Could not find ${owner}/${repo}#${number}`)

  const refuse = (reason: string): MergePlan => ({ kind: 'refuse', reason })
  if (pr.state !== 'OPEN') return refuse(`#${number} is already ${String(pr.state).toLowerCase()}.`)
  if (pr.isDraft) return refuse(`#${number} is a draft. Mark it ready for review on GitHub first.`)
  if (NOT_FOR_MERGE.test(pr.title ?? '')) return refuse(`#${number} is titled "do not merge".`)
  if (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY') return refuse(`#${number} has merge conflicts.`)
  const checks: string | undefined = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state
  if (checks === 'FAILURE' || checks === 'ERROR') return refuse(`#${number} has failing checks.`)
  if (pr.autoMergeRequest) return refuse(`#${number} already has auto-merge on.`)
  if (pr.mergeStateStatus === 'BEHIND') return refuse(`#${number} is behind its base branch. Update the branch on GitHub first.`)

  const base = { id: pr.id as string, headOid: pr.headRefOid as string, method: methodFor(r), number, title: String(pr.title ?? '') }
  if (pr.mergeStateStatus === 'CLEAN' || pr.mergeStateStatus === 'HAS_HOOKS') return { kind: 'merge', ...base }
  if (pr.mergeStateStatus === 'BLOCKED' || checks === 'PENDING' || checks === 'EXPECTED') {
    if (!r.autoMergeAllowed) {
      return refuse(`#${number} cannot be merged yet, and auto-merge is not turned on for ${repo}. Turn it on in the repo's settings, or wait for its checks.`)
    }
    return { kind: 'auto', ...base }
  }
  return refuse(`GitHub has not settled on whether #${number} can be merged (${String(pr.mergeStateStatus).toLowerCase()}). Try again in a moment.`)
}

/** Carries out a plan from `planMerge`; returns a line saying what happened. A refusal from GitHub rejects. */
export const doMerge = async (io: IO, access: Access, plan: Exclude<MergePlan, { kind: 'refuse' }>): Promise<string> => {
  if (plan.kind === 'merge') {
    // expectedHeadOid makes GitHub refuse if the branch moved since the PR was judged.
    const out = await graphql(io, access, MERGE_MUTATION, { id: plan.id, method: plan.method, oid: plan.headOid })
    if (out?.errors?.length || !out?.data?.mergePullRequest) throw failure(out, 'GitHub did not merge it')
    return `Merged #${plan.number}.`
  }
  const out = await graphql(io, access, AUTO_MUTATION, { id: plan.id, method: plan.method })
  if (out?.errors?.length || !out?.data?.enablePullRequestAutoMerge) throw failure(out, 'GitHub did not turn on auto-merge')
  return `Auto-merge is on for #${plan.number}: it merges when its checks pass.`
}

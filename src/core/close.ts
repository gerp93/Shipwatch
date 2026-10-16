// Closing a PR from Shipwatch, without merging it: first look at the PR as it is right now, decide whether
// there is anything to close, then carry it out. Two steps, like merge.ts, so a host can ask before anything
// changes. Closing is reversible (GitHub's Reopen button), but it is still the user's call, so the host asks.

import { graphql } from './github'
import type { Access, IO } from './ports'

/** What clicking Close on a PR would do. */
export type ClosePlan =
  | {
      kind: 'close'
      /** GitHub's id for the PR (what the mutation takes). */
      id: string
      number: number
      title: string
      isDraft: boolean
    }
  | { kind: 'refuse'; reason: string }

const PR_QUERY = `
query($owner:String!,$repo:String!,$n:Int!){
  repository(owner:$owner,name:$repo){
    pullRequest(number:$n){ id number title state isDraft }
  }
}`

const CLOSE_MUTATION = `
mutation($id:ID!){
  closePullRequest(input:{pullRequestId:$id}){ pullRequest{ state } }
}`

const failure = (out: any, fallback: string): Error => new Error(out?.errors?.[0]?.message ?? fallback)

/** Reads the PR fresh from GitHub (the report may be minutes old): only an open PR can be closed. */
export const planClose = async (io: IO, access: Access, owner: string, repo: string, number: number): Promise<ClosePlan> => {
  const out = await graphql(io, access, PR_QUERY, { owner, repo, n: number })
  const pr = out?.data?.repository?.pullRequest
  if (!pr) throw failure(out, `Could not find ${owner}/${repo}#${number}`)
  if (pr.state !== 'OPEN') return { kind: 'refuse', reason: `#${number} is already ${String(pr.state).toLowerCase()}.` }
  return { kind: 'close', id: pr.id as string, number, title: String(pr.title ?? ''), isDraft: pr.isDraft === true }
}

/** Carries out a plan from `planClose`; returns a line saying what happened. A refusal from GitHub rejects. */
export const doClose = async (io: IO, access: Access, plan: Extract<ClosePlan, { kind: 'close' }>): Promise<string> => {
  const out = await graphql(io, access, CLOSE_MUTATION, { id: plan.id })
  if (out?.errors?.length || !out?.data?.closePullRequest) throw failure(out, 'GitHub did not close it')
  return `Closed #${plan.number}. You can reopen it on GitHub.`
}

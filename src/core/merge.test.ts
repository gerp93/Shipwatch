import { expect, test } from 'claude-code/testing'

import { doMerge, planMerge } from './merge'
import type { Access, IO } from './ports'

const ACCESS: Access = { source: 'token', token: 't' }

type Bodies = Array<{ query: string; variables: Record<string, unknown> }>

/** An IO whose GitHub answers with `replies` in turn; the requests it received are collected in `seen`. */
const fakeIO = (replies: unknown[], seen: Bodies = []): IO => {
  let i = 0
  return {
    run: async () => ({ exitCode: 1, stdout: '', stderr: 'no gh here' }),
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init?.body ?? '{}'))
      return { status: 200, ok: true, text: JSON.stringify(replies[i++]) }
    },
  }
}

const answer = (pr: object | null, repo: object = {}) => ({
  data: {
    repository: {
      autoMergeAllowed: true,
      mergeCommitAllowed: true,
      squashMergeAllowed: true,
      rebaseMergeAllowed: true,
      ...repo,
      pullRequest: pr && {
        id: 'PR_1',
        number: 7,
        title: 'Change',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        mergeStateStatus: 'CLEAN',
        headRefOid: 'abc123',
        autoMergeRequest: null,
        commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
        ...pr,
      },
    },
  },
})

const plan = (pr: object | null, repo: object = {}) => planMerge(fakeIO([answer(pr, repo)]), ACCESS, 'o', 'app', 7)
const rollup = (state: string | null) => ({ commits: { nodes: [{ commit: { statusCheckRollup: state && { state } } }] } })

test('a cleanly mergeable PR is merged now, pinned to the commit that was judged', async () => {
  expect(await plan({})).toEqual({ kind: 'merge', id: 'PR_1', headOid: 'abc123', method: 'MERGE', number: 7, title: 'Change' })
  // No checks at all is still clean as far as GitHub is concerned.
  expect((await plan({ ...rollup(null) })).kind).toBe('merge')
})

test('a PR waiting on checks or on requirements gets auto-merge, if the repo allows it', async () => {
  expect((await plan({ mergeStateStatus: 'BLOCKED', ...rollup('PENDING') })).kind).toBe('auto')
  expect((await plan({ mergeStateStatus: 'BLOCKED', ...rollup('SUCCESS') })).kind).toBe('auto')
  const off = await plan({ mergeStateStatus: 'BLOCKED', ...rollup('PENDING') }, { autoMergeAllowed: false })
  expect(off.kind).toBe('refuse')
  expect(off.kind === 'refuse' && off.reason).toContain('auto-merge is not turned on')
})

test('it refuses what cannot or should not be merged, and says why', async () => {
  const reason = async (pr: object | null) => {
    const p = await plan(pr)
    return p.kind === 'refuse' ? p.reason : `(${p.kind})`
  }
  expect(await reason({ state: 'MERGED' })).toContain('already merged')
  expect(await reason({ state: 'CLOSED' })).toContain('already closed')
  expect(await reason({ isDraft: true })).toContain('draft')
  expect(await reason({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toContain('conflicts')
  expect(await reason({ mergeStateStatus: 'UNSTABLE', ...rollup('FAILURE') })).toContain('failing checks')
  expect(await reason({ autoMergeRequest: { enabledAt: 'x' }, mergeStateStatus: 'BLOCKED' })).toContain('already has auto-merge')
  expect(await reason({ mergeStateStatus: 'BEHIND' })).toContain('behind')
  expect(await reason({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' })).toContain('Try again')
})

test('the merge method follows what the repo allows', async () => {
  const method = async (repo: object) => {
    const p = await plan({}, repo)
    return p.kind === 'merge' ? p.method : p.kind
  }
  expect(await method({})).toBe('MERGE')
  expect(await method({ mergeCommitAllowed: false })).toBe('SQUASH')
  expect(await method({ mergeCommitAllowed: false, squashMergeAllowed: false })).toBe('REBASE')
})

test('a PR that does not exist is an error, not a refusal', async () => {
  await expect(plan(null)).rejects.toThrow('Could not find o/app#7')
})

test('carrying out a merge sends the PR id, method and commit; GitHub refusing it rejects', async () => {
  const seen: Bodies = []
  const p = await plan({})
  if (p.kind === 'refuse') throw new Error('expected a plan')
  const said = await doMerge(fakeIO([{ data: { mergePullRequest: { pullRequest: { state: 'MERGED' } } } }], seen), ACCESS, p)
  expect(said).toBe('Merged #7.')
  expect(seen[0]!.variables).toEqual({ id: 'PR_1', method: 'MERGE', oid: 'abc123' })
  expect(seen[0]!.query).toContain('mergePullRequest')

  const refused = { errors: [{ message: 'Head branch was modified' }], data: { mergePullRequest: null } }
  await expect(doMerge(fakeIO([refused]), ACCESS, p)).rejects.toThrow('Head branch was modified')
})

test('carrying out an auto-merge turns it on instead of merging', async () => {
  const seen: Bodies = []
  const p = await plan({ mergeStateStatus: 'BLOCKED', ...rollup('PENDING') })
  if (p.kind === 'refuse') throw new Error('expected a plan')
  const said = await doMerge(fakeIO([{ data: { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: 'x' } } } } }], seen), ACCESS, p)
  expect(said).toContain('Auto-merge is on for #7')
  expect(seen[0]!.query).toContain('enablePullRequestAutoMerge')
  expect(seen[0]!.query).not.toContain('mergePullRequest(')
})

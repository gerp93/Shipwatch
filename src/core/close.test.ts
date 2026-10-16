import { expect, test } from 'claude-code/testing'

import { doClose, planClose } from './close'
import type { Access, IO } from './ports'

const ACCESS: Access = { source: 'gh', token: '' }

/** A stand-in for `gh`: answers each call in turn and records the arguments. */
const fakeIO = (...replies: unknown[]): { io: IO; calls: string[][] } => {
  const calls: string[][] = []
  const io: IO = {
    run: async argv => {
      calls.push(argv)
      return { exitCode: 0, stdout: JSON.stringify(replies.shift()), stderr: '' }
    },
    fetch: async () => {
      throw new Error('no HTTP in this test')
    },
  }
  return { io, calls }
}

const pr = (over: Record<string, unknown> = {}) => ({ data: { repository: { pullRequest: { id: 'PR_1', number: 7, title: 'A change', state: 'OPEN', isDraft: false, ...over } } } })

test('an open PR can be closed, and the plan carries what the dialog needs', async () => {
  const { io } = fakeIO(pr())
  expect(await planClose(io, ACCESS, 'o', 'app', 7)).toEqual({ kind: 'close', id: 'PR_1', number: 7, title: 'A change', isDraft: false })
  expect(await planClose(fakeIO(pr({ isDraft: true })).io, ACCESS, 'o', 'app', 7)).toMatchObject({ kind: 'close', isDraft: true })
})

test('a PR that is already merged or closed is refused, saying which', async () => {
  expect(await planClose(fakeIO(pr({ state: 'MERGED' })).io, ACCESS, 'o', 'app', 7)).toEqual({ kind: 'refuse', reason: '#7 is already merged.' })
  expect(await planClose(fakeIO(pr({ state: 'CLOSED' })).io, ACCESS, 'o', 'app', 7)).toEqual({ kind: 'refuse', reason: '#7 is already closed.' })
})

test('a PR that is not there is an error, not a refusal', async () => {
  let failure = ''
  try {
    await planClose(fakeIO({ data: { repository: { pullRequest: null } } }).io, ACCESS, 'o', 'app', 7)
  } catch (err) {
    failure = String(err)
  }
  expect(failure).toContain('Could not find o/app#7')
})

test('closing sends the PR id and says it can be reopened; a refusal from GitHub rejects', async () => {
  const plan = { kind: 'close' as const, id: 'PR_1', number: 7, title: 'A change', isDraft: false }
  const ok = fakeIO({ data: { closePullRequest: { pullRequest: { state: 'CLOSED' } } } })
  expect(await doClose(ok.io, ACCESS, plan)).toBe('Closed #7. You can reopen it on GitHub.')
  expect(ok.calls[0]!.join(' ')).toContain('id=PR_1')
  expect(ok.calls[0]!.join(' ')).toContain('closePullRequest')

  let failure = ''
  try {
    await doClose(fakeIO({ errors: [{ message: 'Resource not accessible by personal access token' }], data: { closePullRequest: null } }).io, ACCESS, plan)
  } catch (err) {
    failure = String(err)
  }
  expect(failure).toContain('Resource not accessible')
})

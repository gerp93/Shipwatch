import { expect, test } from 'claude-code/testing'

import { CLAIM_PREFIX, CLAIM_WINDOW_MS, REPO_COOLDOWN_MS, claimFix } from './fixClaims'
import type { ClaimResult, ClaimStore } from './fixClaims'

const NOW = Date.parse('2026-10-16T12:00:00Z')

/** A store every "session" shares, whose calls yield like a real one so concurrent sessions interleave. */
const sharedStore = (): ClaimStore & { data: Map<string, unknown> } => {
  const data = new Map<string, unknown>()
  const tick = () => Promise.resolve()
  return {
    data,
    get: async k => (await tick(), data.get(k)),
    set: async (k, v) => (await tick(), void data.set(k, JSON.parse(JSON.stringify(v)))),
    delete: async k => (await tick(), void data.delete(k)),
    keys: async () => (await tick(), [...data.keys()]),
  }
}

// Long enough that every session has written before any reads its claim back.
const settle = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve()
}

const claim = (store: ClaimStore, session: string, over: Partial<Parameters<typeof claimFix>[1]> = {}): Promise<ClaimResult> =>
  claimFix(store, { repo: 'app', commit: 'abc123', session, now: NOW, limit: 5, wait: settle, ...over })

test('eight sessions that see one failure at the same moment send one prompt between them', async () => {
  const store = sharedStore()
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => claim(store, `s${i}`)))
  expect(results.filter(r => r === 'won')).toHaveLength(1)
  expect(results.filter(r => r === 'lost')).toHaveLength(7)
})

test('a session arriving after the claim is settled is told it is a duplicate', async () => {
  const store = sharedStore()
  expect(await claim(store, 'a')).toBe('won')
  expect(await claim(store, 'b')).toBe('duplicate')
  // The same session polling again does not prompt twice either.
  expect(await claim(store, 'a')).toBe('duplicate')
})

test('a second failing commit of the same repo waits out the cooldown', async () => {
  const store = sharedStore()
  expect(await claim(store, 'a', { commit: 'one' })).toBe('won')
  expect(await claim(store, 'b', { commit: 'two', now: NOW + REPO_COOLDOWN_MS - 1 })).toBe('cooldown')
  expect(await claim(store, 'b', { commit: 'two', now: NOW + REPO_COOLDOWN_MS })).toBe('won')
})

test('the limit counts claims across every session and repo inside the window', async () => {
  const store = sharedStore()
  expect(await claim(store, 'a', { repo: 'r1', limit: 2 })).toBe('won')
  expect(await claim(store, 'b', { repo: 'r2', limit: 2 })).toBe('won')
  expect(await claim(store, 'c', { repo: 'r3', limit: 2 })).toBe('limit')
  expect(await claim(store, 'c', { repo: 'r3', limit: 0 })).toBe('limit')
})

test('claims older than the window are forgotten and removed from the store', async () => {
  const store = sharedStore()
  expect(await claim(store, 'a', { limit: 1 })).toBe('won')
  expect(await claim(store, 'b', { commit: 'next', limit: 1, now: NOW + CLAIM_WINDOW_MS + 1 })).toBe('won')
  expect([...store.data.keys()]).toEqual([`${CLAIM_PREFIX}app:next`])
})

test('a claim that was overwritten by something unreadable is dropped, not trusted', async () => {
  const store = sharedStore()
  store.data.set(`${CLAIM_PREFIX}app:abc123`, 'garbage')
  expect(await claim(store, 'a')).toBe('won')
})

test('keys outside the claim prefix are left alone', async () => {
  const store = sharedStore()
  store.data.set('stats:me', { prs: [] })
  expect(await claim(store, 'a')).toBe('won')
  expect(store.data.get('stats:me')).toEqual({ prs: [] })
})

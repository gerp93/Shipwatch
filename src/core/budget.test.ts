import { expect, test } from 'claude-code/testing'

import { RESERVE_FRACTION, isRateLimit, pace, rateLimitMessage, throttleNote } from './budget'
import type { Budget } from './budget'

const NOW = Date.parse('2026-10-15T12:00:00Z')
const HOUR = 3_600_000
const budget = (over: Partial<Budget> = {}): Budget => ({ cost: 10, remaining: 4_900, limit: 5_000, resetAt: NOW + HOUR, ...over })

test('with plenty of allowance left, the wait is what was asked for', () => {
  expect(pace(budget(), NOW, 60_000)).toEqual({ delayMs: 60_000, paused: false })
  expect(pace(undefined, NOW, 60_000)).toEqual({ delayMs: 60_000, paused: false })
  expect(pace(budget({ limit: 0 }), NOW, 20_000)).toEqual({ delayMs: 20_000, paused: false })
})

test('as the allowance runs down the wait stretches so the spendable part lasts to the reset', () => {
  // 2,000 left, 1,500 of it reserved: 500 spendable at 10 a read is 50 reads over the hour, one every 72 s.
  const p = pace(budget({ remaining: 2_000 }), NOW, 20_000)
  expect(p.paused).toBe(false)
  expect(p.delayMs).toBe(72_000)
  // Less left, slower (100 spendable is 10 reads, one every 6 minutes)...
  expect(pace(budget({ remaining: 1_600 }), NOW, 20_000).delayMs).toBe(6 * 60_000)
  // ...and never past the cap while some allowance remains.
  expect(pace(budget({ remaining: 1_520 }), NOW, 20_000).delayMs).toBe(10 * 60_000)
  expect(pace(budget({ remaining: 1_520 }), NOW, 20_000).paused).toBe(false)
  // Near the reset the same allowance buys faster reads again.
  expect(pace(budget({ remaining: 2_000, resetAt: NOW + 5 * 60_000 }), NOW, 20_000).delayMs).toBe(20_000)
})

test('with only the reserve left, polling waits for the reset instead of spending it', () => {
  const reserve = 5_000 * RESERVE_FRACTION
  const p = pace(budget({ remaining: reserve + 5, cost: 9 }), NOW, 60_000)
  expect(p.paused).toBe(true)
  expect(p.delayMs).toBe(HOUR + 5_000)
  // An allowance already reset still waits at least what was asked for.
  expect(pace(budget({ remaining: 0, resetAt: NOW - 1_000 }), NOW, 60_000)).toEqual({ delayMs: 60_000, paused: true })
})

test('rate-limit wording from GitHub is recognised, and an ordinary failure is not', () => {
  expect(isRateLimit('gh: API rate limit already exceeded for user ID 9903389.')).toBe(true)
  expect(isRateLimit('You have exceeded a secondary rate limit')).toBe(true)
  expect(isRateLimit('GitHub answered 403')).toBe(true)
  expect(isRateLimit('GitHub answered 429')).toBe(true)
  expect(isRateLimit('GitHub answered 404')).toBe(false)
  expect(isRateLimit('Could not find o/app#7')).toBe(false)
})

test('the messages say what happened and when it clears', () => {
  const at = (ms: number) => `T+${Math.round((ms - NOW) / 60_000)}m`
  const known = rateLimitMessage(NOW + 8 * 60_000, NOW, at)
  expect(known).toContain('used up')
  expect(known).toContain('shared by everything signed in as you')
  expect(known).toContain('resets at T+8m')
  expect(rateLimitMessage(undefined, NOW, at)).toContain('try again shortly')
  expect(rateLimitMessage(NOW - 1, NOW, at)).toContain('try again shortly') // a reset time already past is no help
  const b = budget({ remaining: 2_000 })
  expect(throttleNote(b, pace(b, NOW, 20_000), at)).toContain('Polling every 72 s')
  expect(throttleNote(b, pace(b, NOW, 20_000), at)).toContain('2,000 of 5,000 left')
  const spent = budget({ remaining: 1_000 })
  expect(throttleNote(spent, pace(spent, NOW, 20_000), at)).toContain('Paused until T+60m')
})

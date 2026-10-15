import { expect, test } from 'claude-code/testing'

import { BURST_PAUSE_MS, RESERVE_FRACTION, adviseOnLimit, isBurstLimit, isRateLimit, pace, rateLimitMessage, reserveMessage, throttleNote } from './budget'
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

test('a refusal with allowance left is a burst limit, and one with none left is the hourly limit', () => {
  const at = (ms: number) => `T+${Math.round((ms - NOW) / 60_000)}m`
  expect(isBurstLimit({ remaining: 4_835, resetAt: NOW + HOUR })).toBe(true)
  expect(isBurstLimit({ remaining: 0, resetAt: NOW + HOUR })).toBe(false)
  expect(isBurstLimit({ remaining: undefined, resetAt: NOW + HOUR })).toBe(false)
  expect(isBurstLimit(undefined)).toBe(false)

  const burst = adviseOnLimit({ remaining: 4_835, resetAt: NOW + HOUR }, NOW, at)
  expect(burst.burst).toBe(true)
  expect(burst.retryInMs).toBe(BURST_PAUSE_MS)
  expect(burst.message).toContain('briefly slowing')
  expect(burst.message).toContain('4,835 points are still left')
  expect(burst.message).not.toContain('used up') // it must not claim the hourly allowance is spent

  const hourly = adviseOnLimit({ remaining: 0, resetAt: NOW + 8 * 60_000 }, NOW, at)
  expect(hourly.burst).toBe(false)
  expect(hourly.retryInMs).toBe(8 * 60_000 + 5_000)
  expect(hourly.message).toContain('used up')
  expect(hourly.message).toContain('resets at T+8m')

  // Not able to ask: say the hourly thing is unknown and retry in a minute.
  const unknown = adviseOnLimit(undefined, NOW, at)
  expect(unknown.burst).toBe(false)
  expect(unknown.retryInMs).toBe(60_000)
})

test('stopping to leave the reserve says why and when to come back', () => {
  const at = (ms: number) => `T+${Math.round((ms - NOW) / 60_000)}m`
  expect(reserveMessage(NOW + 30 * 60_000, NOW, at)).toContain('resets at T+30m')
  expect(reserveMessage(NOW - 1, NOW, at)).toContain('Choose Refresh')
})

import { expect, test } from 'claude-code/testing'

import { RESERVE_FRACTION, adviseOnLimit, isRateLimit, limitTone, pace, reserveMessage, throttleNote } from './budget'
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

test('the throttle note says what the pacing is doing and why', () => {
  const at = (ms: number) => `T+${Math.round((ms - NOW) / 60_000)}m`
  const b = budget({ remaining: 2_000 })
  expect(throttleNote(b, pace(b, NOW, 20_000), at)).toContain('Polling every 72 s')
  expect(throttleNote(b, pace(b, NOW, 20_000), at)).toContain('2,000 of 5,000 left')
  const spent = budget({ remaining: 1_000 })
  expect(throttleNote(spent, pace(spent, NOW, 20_000), at)).toContain('Paused until T+60m')
})

test('a refusal is explained with what GitHub reports, and retried at the reset time it gives', () => {
  const at = (ms: number) => `T+${Math.round((ms - NOW) / 60_000)}m`

  // Refused with points left: the same thing as any other refusal. It waits for the reset GitHub reports.
  const refused = adviseOnLimit({ remaining: 4_835, limit: 5_000, resetAt: NOW + HOUR }, NOW, at)
  expect(refused.retryInMs).toBe(HOUR + 5_000)
  expect(refused.message).toContain('GitHub refused the request with a rate-limit error')
  expect(refused.message).toContain('shows 4,835 of 5,000 points left and a reset at T+60m; Shipwatch will try again then')
  // Nothing Shipwatch made up: no invented kind of limit, no delay of its own.
  for (const guess of ['burst', 'briefly', 'short-term', 'usually', 'does not say', '90 s']) expect(refused.message).not.toContain(guess)
  expect(refused.giveUp).toContain('Choose Refresh after that')
  expect(refused.giveUp).not.toContain('will try again')

  // Allowance spent: the same, with nothing left.
  const spent = adviseOnLimit({ remaining: 0, limit: 5_000, resetAt: NOW + 8 * 60_000 }, NOW, at)
  expect(spent.retryInMs).toBe(8 * 60_000 + 5_000)
  expect(spent.message).toContain('0 of 5,000 points left and a reset at T+8m')

  // A reset time already past is no help: ask again in a minute, and say that.
  const passed = adviseOnLimit({ remaining: 0, limit: 5_000, resetAt: NOW - 1 }, NOW, at)
  expect(passed.retryInMs).toBe(60_000)
  expect(passed.message).toContain('has passed')

  // Could not read GitHub's status at all: say that, and invent nothing.
  const unknown = adviseOnLimit(undefined, NOW, at)
  expect(unknown.retryInMs).toBe(60_000)
  expect(unknown.message).toContain("could not read GitHub's rate-limit status")
  expect(unknown.message).not.toContain('points left')
})

test('the readout is calm above 30%, low under it and urgent under 10%', () => {
  expect(limitTone({ remaining: 4_000, limit: 5_000, resetAt: NOW })).toBe('ok')
  expect(limitTone({ remaining: 1_400, limit: 5_000, resetAt: NOW })).toBe('low')
  expect(limitTone({ remaining: 400, limit: 5_000, resetAt: NOW })).toBe('critical')
  expect(limitTone({ remaining: 0, limit: 0, resetAt: NOW })).toBe('ok')
})

test('stopping to leave the reserve says why and when to come back', () => {
  const at = (ms: number) => `T+${Math.round((ms - NOW) / 60_000)}m`
  expect(reserveMessage(NOW + 30 * 60_000, NOW, at)).toContain('resets at T+30m')
  expect(reserveMessage(NOW - 1, NOW, at)).toContain('Choose Refresh')
})

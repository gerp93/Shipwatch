// GitHub's API allowance, and how Shipwatch stays inside it.
//
// GraphQL gets 5,000 points an hour per account, shared by everything signed in as that account: every Claude
// session running Shipwatch (each polls on its own), the `gh` CLI, the app, other tools. A dashboard read costs
// a handful of points, so a few open sessions can use the whole hour, and then `gh pr create` fails too.
// So polling is paced by what is left, and a share of the hour is never touched.

export type Budget = {
  /** Points the last query cost. */
  cost: number
  remaining: number
  limit: number
  /** When the allowance resets, epoch ms. */
  resetAt: number
}

/** The share of the hourly allowance left alone for everything else (other tools, `gh`, fix PRs). */
export const RESERVE_FRACTION = 0.3
/** The longest Shipwatch slows polling for while there is still allowance; past that it stops and waits for the reset. */
const MAX_SLOWED_MS = 10 * 60_000
const RESET_MARGIN_MS = 5_000

export const RATE_LIMITED = /rate limit|secondary|abuse|answered (403|429)/i
export const isRateLimit = (message: string): boolean => RATE_LIMITED.test(message)

export type Pace = {
  /** How long to wait before the next read. */
  delayMs: number
  /** True when polling has stopped until the allowance resets (only the reserve is left). */
  paused: boolean
}

/**
 * How long to wait before the next read, given what the last one left. With plenty left it is `wantedMs`.
 * As the allowance runs down it stretches, so the points that can be spent (everything above the reserve)
 * last until the reset; with only the reserve left it waits for the reset instead of spending it.
 */
export const pace = (budget: Budget | undefined, now: number, wantedMs: number): Pace => {
  if (!budget || !(budget.limit > 0)) return { delayMs: wantedMs, paused: false }
  const untilReset = Math.max(0, budget.resetAt - now)
  const spendable = budget.remaining - budget.limit * RESERVE_FRACTION
  const cost = Math.max(1, budget.cost)
  if (spendable < cost) return { delayMs: Math.max(wantedMs, untilReset + RESET_MARGIN_MS), paused: true }
  const evenly = (untilReset * cost) / spendable
  return { delayMs: Math.min(MAX_SLOWED_MS, Math.max(wantedMs, Math.ceil(evenly))), paused: false }
}

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** What to tell the person when GitHub refuses for rate limiting; `resetAt` is epoch ms when known. */
export const rateLimitMessage = (resetAt: number | undefined, now: number, format: (ms: number) => string = timeOf): string =>
  "GitHub's hourly API allowance for this account is used up. It is shared by everything signed in as you (every Claude session running Shipwatch, the gh CLI, other tools). " +
  (resetAt && resetAt > now ? `It resets at ${format(resetAt)}; Shipwatch will carry on then.` : 'Shipwatch will try again shortly.')

/** What a throttled or paused dashboard says about itself. */
export const throttleNote = (budget: Budget, p: Pace, format: (ms: number) => string = timeOf): string =>
  p.paused
    ? `Paused until ${format(budget.resetAt)}: only the share kept for your other tools is left of GitHub's hourly allowance.`
    : `Polling every ${Math.round(p.delayMs / 1000)} s to stay inside GitHub's hourly allowance (${budget.remaining.toLocaleString('en-US')} of ${budget.limit.toLocaleString('en-US')} left, resets ${format(budget.resetAt)}).`

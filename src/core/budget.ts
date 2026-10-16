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

/** One of GitHub's allowances as the free `rate_limit` endpoint reports it. `resetAt` is epoch ms. */
export type ApiLimit = { remaining: number; limit: number; resetAt: number }

/** The two that matter here: GraphQL (the dashboard and stats) and REST core (workflow runs, `gh api`). */
export type ApiLimits = { graphql?: ApiLimit; core?: ApiLimit }

/** How a readout of an allowance is worded and how worried to look: more than 30% left is calm, under 10% is urgent. */
export const limitTone = (l: ApiLimit): 'ok' | 'low' | 'critical' => {
  const share = l.limit > 0 ? l.remaining / l.limit : 1
  return share < 0.1 ? 'critical' : share < RESERVE_FRACTION ? 'low' : 'ok'
}

export type LimitAdvice = {
  /** What to tell the person while Shipwatch waits: that the limit was hit, when GitHub says it resets, and that it will try then. */
  message: string
  /** What to tell the person once Shipwatch has stopped trying. */
  giveUp: string
  /** How long until the reset GitHub reports, so when to ask again; a minute if GitHub gave no usable time. */
  retryInMs: number
}

const count = (n: number): string => n.toLocaleString('en-US')

/**
 * What to say and do when GitHub refuses a request for rate limiting: say that, say when GitHub says it resets,
 * and try again then. Only the reset time is stated: the number of points left is left out, because the two places
 * GitHub reports it can disagree (see `fetchLimitStatus`), and the refusal itself already says the limit was hit.
 */
export const adviseOnLimit = (limit: ApiLimit | undefined, now: number, format: (ms: number) => string = timeOf): LimitAdvice => {
  const refused = 'GitHub refused the request with a rate-limit error.'
  if (!limit) {
    return {
      message: `${refused} Shipwatch could not read GitHub's rate-limit status to see when it resets, and will try again in a minute.`,
      giveUp: `${refused} Shipwatch could not read GitHub's rate-limit status to see when it resets. Choose Refresh to try again.`,
      retryInMs: 60_000,
    }
  }
  const resets = `GitHub says it resets at ${format(limit.resetAt)}`
  if (!(limit.resetAt > now)) {
    return { message: `${refused} ${resets}, which has passed; Shipwatch will try again in a minute.`, giveUp: `${refused} ${resets}, which has passed. Choose Refresh to try again.`, retryInMs: 60_000 }
  }
  return {
    message: `${refused} ${resets}; Shipwatch will try again then.`,
    giveUp: `${refused} ${resets}. Choose Refresh after that to try again.`,
    retryInMs: limit.resetAt - now + RESET_MARGIN_MS,
  }
}

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })

/** What a long load says when it stops to leave the reserve alone. */
export const reserveMessage = (resetAt: number, now: number, format: (ms: number) => string = timeOf): string =>
  "Stopped to keep part of GitHub's hourly allowance free for your other tools (gh, other sessions). " +
  (resetAt > now ? `It resets at ${format(resetAt)}; choose Refresh then to carry on from what is saved.` : 'Choose Refresh to carry on from what is saved.')

/** What a throttled or paused dashboard says about itself. */
export const throttleNote = (budget: Budget, p: Pace, format: (ms: number) => string = timeOf): string =>
  p.paused
    ? `Paused until ${format(budget.resetAt)}: only the share kept for your other tools is left of GitHub's hourly allowance.`
    : `Polling every ${Math.round(p.delayMs / 1000)} s to stay inside GitHub's hourly allowance (${budget.remaining.toLocaleString('en-US')} of ${budget.limit.toLocaleString('en-US')} left, resets ${format(budget.resetAt)}).`

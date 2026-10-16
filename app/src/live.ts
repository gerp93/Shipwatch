// Helpers for filling the report in after it is on screen: the app opens on what it already knows and updates behind
// it, handing the page each part as it arrives. Plain strings and a throttle, so they can be tested without Electron.

import type { ApiLimits } from '../../src/core/budget'
import { jsonForScript } from '../../src/core/report'
import type { BoardStatus, ReportData, StatsStatus } from '../../src/core/report'
import type { RecentPr } from '../../src/core/types'

/** A call into the page's `shipwatchLive`. The arguments are written as literals that cannot end the script early. */
const call = (method: string, ...args: unknown[]): string => `window.shipwatchLive&&window.shipwatchLive.${method}(${args.map(a => jsonForScript(a)).join(',')})`

/** The stats history so far. */
export const setStatsScript = (stats: ReportData['stats']): string => call('setStats', stats)

/** Session time and tokens per repo, read from Claude Code's history, for the Builds tab. */
export const setEffortScript = (effort: NonNullable<ReportData['effort']>): string => call('setEffort', effort)

/** How loading the stats is going; `null` says it is finished. */
export const setStatusScript = (status: StatsStatus | null): string => call('setStatus', status)

/** A freshly read dashboard (and the last hour's PRs when known), replacing the saved one on screen. */
export const setBoardScript = (board: ReportData['board'], generatedAt: number, recent: RecentPr[] | undefined): string => call('setBoard', board, generatedAt, recent ?? null)

/** How updating the dashboard is going; `null` says the dashboard on screen is current. */
export const setBoardStatusScript = (status: BoardStatus | null): string => call('setBoardStatus', status)

/** The PRs opened in the last hour, for the clock's rim. */
export const setRecentScript = (recent: RecentPr[]): string => call('setRecent', recent)

/** When the dashboard is next read (epoch ms), or `null` while it is being read now; drives the countdown in the header. */
export const setNextRefreshScript = (at: number | null): string => call('setNextRefresh', at)

/** What is left of GitHub's allowances, for the readout in the header. */
export const setApiScript = (api: ApiLimits): string => call('setApi', api)

/** Passes a value on at most once every `ms`, dropping the ones between (the next call after the gap sends the latest). */
export const throttled = <T>(ms: number, send: (value: T) => void, clock: () => number = Date.now): ((value: T) => void) => {
  let last = Number.NEGATIVE_INFINITY
  return value => {
    const at = clock()
    if (at - last < ms) return
    last = at
    send(value)
  }
}

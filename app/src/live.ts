// Helpers for filling the report in after it is on screen: the dashboard is shown first, then the stats history
// is handed to the page as it arrives. Plain strings and a throttle, so they can be tested without Electron.

import { jsonForScript } from '../../src/core/report'
import type { ReportData, StatsStatus } from '../../src/core/report'

/** Script that gives the page the history so far. The data is written as a literal that cannot end the script early. */
export const setStatsScript = (stats: ReportData['stats']): string => `window.shipwatchLive&&window.shipwatchLive.setStats(${jsonForScript(stats)})`

/** Script that tells the page how loading is going; `null` says it is finished. */
export const setStatusScript = (status: StatsStatus | null): string => `window.shipwatchLive&&window.shipwatchLive.setStatus(${jsonForScript(status)})`

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

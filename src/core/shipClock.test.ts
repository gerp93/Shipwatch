import { expect, test } from 'claude-code/testing'

import { DOT_COLOR, clockTime, describeHour, dotStatus, dotsFor, handAngles, hourShades, inWindow, shipClockSvg, summarize, sweepPaths } from './shipClock'
import type { RecentPr } from './types'

// A fixed instant, and minutes read in UTC, so the tests do not depend on the machine's time zone.
const NOW = Date.parse('2026-10-15T14:30:00Z')
const MIN = 60_000
const utcMinute = (ms: number): number => new Date(ms).getUTCMinutes() + new Date(ms).getUTCSeconds() / 60

const pr = (n: number, minutesAgo: number, over: Partial<RecentPr> = {}): RecentPr => ({
  repo: 'app',
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/o/app/pull/${n}`,
  createdAt: new Date(NOW - minutesAgo * MIN).toISOString(),
  state: 'open',
  isDraft: false,
  checks: 'none',
  mergedAt: null,
  ...over,
})

test('only PRs opened in the last 60 minutes count, newest first, and one drops off when its hour is up', () => {
  const prs = [pr(1, 5), pr(2, 59), pr(3, 61), pr(4, 120), pr(5, 0)]
  expect(inWindow(prs, NOW).map(p => p.number)).toEqual([5, 1, 2])
  // A minute later the 59-minute-old one has gone, and the 61-minute-old one never came back.
  expect(inWindow(prs, NOW + 2 * MIN).map(p => p.number)).toEqual([5, 1])
  // A PR from the future (a clock a little out) is not drawn.
  expect(inWindow([pr(6, -10)], NOW)).toEqual([])
})

test('a dot sits at the minute its PR was opened', () => {
  const dots = dotsFor([pr(1, 15), pr(2, 45)], NOW, utcMinute)
  const byNumber = Object.fromEntries(dots.map(d => [d.pr.number, d]))
  expect(byNumber[1]!.angle).toBe(90) // opened at :15 is a quarter turn
  expect(byNumber[2]!.angle).toBe(270) // opened at :45 is three quarters
  expect(byNumber[1]!.minutesAgo).toBe(15)
  // Seconds count: 14:15:30 is half a minute past the quarter.
  const d = dotsFor([{ ...pr(3, 0), createdAt: '2026-10-15T14:15:30Z' }], NOW, utcMinute)[0]!
  expect(d.angle).toBe(93)
})

test('PRs opened in the same minute are put on different tracks so none hides another', () => {
  const same = [pr(1, 10), pr(2, 10), pr(3, 10), pr(4, 10), pr(5, 10)]
  const tracks = dotsFor(same, NOW, utcMinute).map(d => d.track)
  expect(tracks.slice(0, 4)).toEqual([0, 1, 2, 3])
  expect(Math.max(...tracks)).toBe(3) // beyond the inner track they share it rather than leave the dial
  // Minutes apart, they stay on the outer track.
  expect(dotsFor([pr(1, 10), pr(2, 30)], NOW, utcMinute).map(d => d.track)).toEqual([0, 0])
})

test('a dot is coloured by where its PR stands now', () => {
  expect(dotStatus(pr(1, 1, { state: 'merged', mergedAt: '2026-10-15T14:29:00Z' }))).toBe('merged')
  expect(dotStatus(pr(1, 1, { state: 'closed' }))).toBe('closed')
  expect(dotStatus(pr(1, 1, { isDraft: true, checks: 'failing' }))).toBe('draft') // a draft is a draft first
  expect(dotStatus(pr(1, 1, { checks: 'failing' }))).toBe('failing')
  expect(dotStatus(pr(1, 1, { checks: 'running' }))).toBe('building')
  expect(dotStatus(pr(1, 1, { checks: 'passing' }))).toBe('ready')
  expect(dotStatus(pr(1, 1))).toBe('open')
  expect(new Set(Object.values(DOT_COLOR)).size).toBeGreaterThan(4)
})

test('the hour is summed up in a line', () => {
  const prs = [
    pr(1, 5, { state: 'merged', mergedAt: '2026-10-15T14:26:00Z' }),
    pr(2, 8, { state: 'merged', mergedAt: '2026-10-15T14:24:00Z' }),
    pr(3, 12, { checks: 'running' }),
    pr(4, 20, { checks: 'failing' }),
    pr(5, 40, { state: 'closed' }),
    pr(6, 90), // outside the hour
  ]
  const s = summarize(prs, NOW)
  expect(s).toEqual({ opened: 5, merged: 2, open: 2, failing: 1, building: 1, closed: 1 })
  expect(describeHour(s)).toBe('5 PRs opened in the last hour: 2 merged, 2 open (1 failing), 1 closed')
  expect(describeHour(summarize([pr(1, 3)], NOW))).toBe('1 PR opened in the last hour: 1 open')
  expect(describeHour(summarize([], NOW))).toBe('No PRs opened in the last hour')
})

test('the hands show the time: the hour hand moves with the minutes, the minute hand with the seconds', () => {
  expect(handAngles({ hours: 3, minutes: 0, seconds: 0 })).toEqual({ hour: 90, minute: 0, second: 0 })
  expect(handAngles({ hours: 15, minutes: 30, seconds: 0 })).toEqual({ hour: 105, minute: 180, second: 0 }) // 3:30 pm is halfway between 3 and 4
  expect(handAngles({ hours: 12, minutes: 0, seconds: 30 })).toEqual({ hour: 0, minute: 3, second: 180 })
  const t = clockTime(Date.parse('2026-10-15T14:30:15Z'))
  expect(t.seconds).toBe(15)
})

test('the drawing carries the hands at the time, a dot per PR with its details, and escapes what GitHub supplied', () => {
  const hostile = pr(7, 20, { title: '<img src=x onerror=alert(1)> & more', repo: 'a"b' })
  const dots = dotsFor([pr(1, 15, { checks: 'passing' }), hostile], NOW, utcMinute)
  const svg = shipClockSvg(NOW, dots, { format: () => 'HH:MM' })
  expect(svg.match(/class="dot"/g)?.length).toBe(2)
  expect(svg).toContain('class="hh"')
  expect(svg).toContain('class="mh"')
  expect(svg).toContain('class="sh"')
  expect(svg).toContain('#1 app: Change 1 (opened HH:MM, open, checks passing)')
  expect(svg).not.toContain('<img')
  expect(svg).toContain('&lt;img')
  expect(svg).not.toContain('NaN')
  // The second hand can be left off (for people who ask for less motion).
  expect(shipClockSvg(NOW, [], { seconds: false })).not.toContain('class="sh"')
  expect(shipClockSvg(NOW, [])).toContain('No PRs opened in the last hour')
})

test('the two shades take turns each hour, so the new hour sweeps its colour over the old one', () => {
  expect(hourShades(14)).toEqual(['--clock-a', '--clock-b']) // an even hour: A is this hour, B is the hour before
  expect(hourShades(15)).toEqual(['--clock-b', '--clock-a']) // the next hour swaps them
  expect(hourShades(0)).toEqual(['--clock-a', '--clock-b'])
  expect(hourShades(23)).toEqual(['--clock-b', '--clock-a'])
  // At the turn of the hour the colour that was sweeping becomes the old one: nothing is left of it to flip.
  expect(hourShades(14)[0]).toBe(hourShades(15)[1])
})

test('the sweep covers the dial from 12 to the minute hand, and the rest of it is left to the other shade', () => {
  const quarter = sweepPaths(90) // :15
  expect(quarter.done).toBe('M100 100 L100 5 A95 95 0 0 1 195 100 Z') // a quarter turn, the short way round
  expect(quarter.rest).toBe('M100 100 L195 100 A95 95 0 1 1 100 5 Z') // the other three quarters, the long way
  // Past the half hour the swept part is the long way round.
  expect(sweepPaths(270).done).toContain('A95 95 0 1 1 5 100')
  expect(sweepPaths(270).rest).toContain('A95 95 0 0 1 100 5')
  // At the very start only the old shade shows; at the very end only the new one (never a blank dial).
  expect(sweepPaths(0).done).toBe('')
  expect(sweepPaths(0).rest).not.toBe('')
  expect(sweepPaths(360).rest).toBe('')
  expect(sweepPaths(360).done).not.toBe('')
  expect(sweepPaths(-5)).toEqual(sweepPaths(0))
  expect(sweepPaths(400)).toEqual(sweepPaths(360))
})

test('the drawing shades the swept part in the current hour colour and the rest in the last hour colour, swapping at the hour', () => {
  const even = new Date(2026, 9, 15, 14, 30, 0).getTime() // local time, so the test holds in any time zone
  const odd = new Date(2026, 9, 15, 15, 30, 0).getTime()
  const shade = (svg: string, cls: string) => new RegExp(`class="${cls}"[^>]*style="fill:var\\((--clock-[ab])`).exec(svg)?.[1]
  const a = shipClockSvg(even, [])
  expect(shade(a, 'sw-done')).toBe('--clock-a')
  expect(shade(a, 'sw-rest')).toBe('--clock-b')
  const b = shipClockSvg(odd, [])
  expect(shade(b, 'sw-done')).toBe('--clock-b')
  expect(shade(b, 'sw-rest')).toBe('--clock-a')
  // Half past: the swept wedge ends at 6 o'clock.
  expect(a).toContain('A95 95 0 0 1 100 195') // 180 degrees is the long-way boundary, so the short arc
})

// The ship clock: a real analog clock whose rim shows what has been shipped in the last hour. The hour and minute
// hands (and a second hand) show the actual time; a dot sits on the rim at the minute each PR was opened, in the
// last 60 minutes, coloured by where that PR stands now. So the dial reads like an hour of work: dots piling up
// around it is a busy hour, and each one drops off when its minute comes round again an hour later.
// Pure text in, text out, like charts.ts, so a web report or an app embeds the same markup.

import type { RecentPr } from './types'

/** The rolling window the clock shows. */
export const WINDOW_MS = 60 * 60_000

/** Where a recent PR stands, as the clock colours it. */
export type DotStatus = 'merged' | 'ready' | 'building' | 'failing' | 'open' | 'draft' | 'closed'

export const DOT_COLOR: Record<DotStatus, string> = {
  merged: '#8a7bd8',
  ready: '#3fa66b',
  building: '#d9a520',
  failing: '#e5534b',
  open: '#4c8dff',
  draft: '#8b929c',
  closed: '#da3633',
}

export const DOT_LABEL: Record<DotStatus, string> = {
  merged: 'merged',
  ready: 'open, checks passing',
  building: 'open, checks running',
  failing: 'open, checks failing',
  open: 'open',
  draft: 'draft',
  closed: 'closed without merging',
}

/** The status a recent PR is drawn as. */
export const dotStatus = (pr: RecentPr): DotStatus => {
  if (pr.state === 'merged') return 'merged'
  if (pr.state === 'closed') return 'closed'
  if (pr.parked) return 'draft'
  if (pr.checks === 'failing') return 'failing'
  if (pr.checks === 'running') return 'building'
  if (pr.checks === 'passing') return 'ready'
  return 'open'
}

/** The PRs opened in the last hour (after `now` minus the window, up to now), newest first. */
export const inWindow = (prs: readonly RecentPr[], now: number, windowMs = WINDOW_MS): RecentPr[] =>
  prs
    .filter(p => {
      const t = Date.parse(p.createdAt)
      return Number.isFinite(t) && t > now - windowMs && t <= now
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

/** Minutes past the hour, with the seconds as a fraction (0 up to 60), in the reader's own time zone. */
export const localMinute = (ms: number): number => {
  const d = new Date(ms)
  return d.getMinutes() + d.getSeconds() / 60
}

/** One dot on the rim. */
export type Dot = {
  pr: RecentPr
  status: DotStatus
  /** Degrees clockwise from 12: the minute it was opened. */
  angle: number
  /** 0 is the outermost track; dots opened within a moment of each other take inner tracks so none hide another. */
  track: number
  minutesAgo: number
}

const TRACKS = 4
/** Dots closer than this (degrees) share a track only if they would overlap, so they are put on different ones. */
const CLEARANCE = 13

const angularGap = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360
  return d > 180 ? 360 - d : d
}

/** The dots for `prs` as of `now`, oldest first. `minuteOf` says which minute of the hour an instant falls on. */
export const dotsFor = (prs: readonly RecentPr[], now: number, minuteOf: (ms: number) => number = localMinute): Dot[] => {
  const dots: Dot[] = []
  for (const pr of inWindow(prs, now).reverse()) {
    const at = Date.parse(pr.createdAt)
    const angle = Math.round(minuteOf(at) * 6 * 10) / 10
    let track = 0
    while (track < TRACKS - 1 && dots.some(d => d.track === track && angularGap(d.angle, angle) < CLEARANCE)) track += 1
    dots.push({ pr, status: dotStatus(pr), angle, track, minutesAgo: Math.floor((now - at) / 60_000) })
  }
  return dots
}

/** Counts for the last hour. */
export type HourSummary = { opened: number; merged: number; open: number; failing: number; building: number; closed: number }

export const summarize = (prs: readonly RecentPr[], now: number): HourSummary => {
  const recent = inWindow(prs, now)
  const count = (pick: (p: RecentPr) => boolean): number => recent.filter(pick).length
  return {
    opened: recent.length,
    merged: count(p => p.state === 'merged'),
    open: count(p => p.state === 'open'),
    failing: count(p => p.state === 'open' && p.checks === 'failing'),
    building: count(p => p.state === 'open' && p.checks === 'running'),
    closed: count(p => p.state === 'closed'),
  }
}

/** One line for the label and tooltip: "7 opened in the last hour: 4 merged, 2 open (1 building), 1 closed". */
export const describeHour = (s: HourSummary): string => {
  if (s.opened === 0) return 'No PRs opened in the last hour'
  const open = s.open > 0 ? `${s.open} open${s.failing ? ` (${s.failing} failing)` : s.building ? ` (${s.building} building)` : ''}` : ''
  const parts = [s.merged && `${s.merged} merged`, open, s.closed && `${s.closed} closed`].filter(Boolean)
  return `${s.opened} ${s.opened === 1 ? 'PR' : 'PRs'} opened in the last hour${parts.length ? `: ${parts.join(', ')}` : ''}`
}

// ---- Hands -------------------------------------------------------------------------------------------------

export type ClockTime = { hours: number; minutes: number; seconds: number }

export const clockTime = (ms: number): ClockTime => {
  const d = new Date(ms)
  return { hours: d.getHours(), minutes: d.getMinutes(), seconds: d.getSeconds() + d.getMilliseconds() / 1000 }
}

/** Degrees clockwise from 12 for each hand. */
export const handAngles = (t: ClockTime): { hour: number; minute: number; second: number } => ({
  hour: ((t.hours % 12) + t.minutes / 60) * 30,
  minute: (t.minutes + t.seconds / 60) * 6,
  second: t.seconds * 6,
})

// ---- The hour's sweep ---------------------------------------------------------------------------------------

/** The two shades the dial alternates between, as CSS variables with fallbacks for hosts that do not define them. */
export type Shade = '--clock-a' | '--clock-b'
export const SHADE_FALLBACK: Record<Shade, string> = { '--clock-a': '#4c8dff', '--clock-b': '#8a7bd8' }

/**
 * The shades for the hour that is running and the one before it. They take turns: an even hour is shaded A over
 * B, an odd hour B over A, so as the minute hand sweeps from 12 the new hour's shade grows over the old one's.
 */
export const hourShades = (hours: number): [thisHour: Shade, lastHour: Shade] => (hours % 2 === 0 ? ['--clock-a', '--clock-b'] : ['--clock-b', '--clock-a'])

const RIM = 95

const pointOn = (angle: number): [number, number] => {
  const a = (angle * Math.PI) / 180
  return [100 + Math.sin(a) * RIM, 100 - Math.cos(a) * RIM]
}

/**
 * The two wedges of the dial: `done` from 12 round to the minute hand (this hour so far) and `rest` from the hand
 * on to 12 (what is left of the dial, still last hour's shade). Either is empty at the extremes of the hour.
 */
export const sweepPaths = (minuteAngle: number): { done: string; rest: string } => {
  const angle = Math.min(360, Math.max(0, minuteAngle))
  const [x, y] = pointOn(angle)
  const top = pointOn(0)
  const r1 = (n: number): string => String(Math.round(n * 10) / 10)
  const done = angle <= 0 ? '' : angle >= 360 ? `M100 100 L${r1(top[0])} ${r1(top[1])} A${RIM} ${RIM} 0 1 1 ${r1(top[0] - 0.01)} ${r1(top[1])} Z` : `M100 100 L${r1(top[0])} ${r1(top[1])} A${RIM} ${RIM} 0 ${angle > 180 ? 1 : 0} 1 ${r1(x)} ${r1(y)} Z`
  const rest = angle >= 360 ? '' : angle <= 0 ? `M100 100 L${r1(top[0])} ${r1(top[1])} A${RIM} ${RIM} 0 1 1 ${r1(top[0] - 0.01)} ${r1(top[1])} Z` : `M100 100 L${r1(x)} ${r1(y)} A${RIM} ${RIM} 0 ${360 - angle > 180 ? 1 : 0} 1 ${r1(top[0])} ${r1(top[1])} Z`
  return { done, rest }
}

// ---- Drawing -----------------------------------------------------------------------------------------------

const esc = (s: string): string => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const r1 = (n: number): string => String(Math.round(n * 10) / 10)

const point = (angle: number, radius: number): [number, number] => {
  const a = (angle * Math.PI) / 180
  return [100 + Math.sin(a) * radius, 100 - Math.cos(a) * radius]
}

const pad = (n: number): string => String(n).padStart(2, '0')

const hand = (cls: string, length: number, tail: number, width: number): string => {
  const [x2, y2] = point(0, length)
  const [x1, y1] = point(180, tail)
  return `<line class="${cls}" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke-width="${width}" stroke-linecap="round"/>`
}

const STYLE =
  '<style>.face{fill:#8b929c;fill-opacity:.1;stroke:#8b929c;stroke-opacity:.6;stroke-width:3}' +
  '.tick{stroke:#8b929c;stroke-opacity:.45;stroke-width:1}.mark{stroke:#8b929c;stroke-opacity:.8;stroke-width:2}' +
  '.hh,.mh{stroke:var(--clock-hand,#1f2328)}.sh{stroke:#e5534b}' +
  '@media (prefers-color-scheme:dark){.hh,.mh{stroke:var(--clock-hand,#e6edf3)}}</style>'

/** Where the rim's dots sit: the outermost track, then inwards. */
const trackRadius = (track: number): number => 79 - track * 13

export type ClockOptions = {
  size?: number
  /** Draw the second hand. The page moves it; here it is only placed at `now`. */
  seconds?: boolean
  /** Format a time for a dot's tooltip (default: HH:MM in the reader's zone). */
  format?: (ms: number) => string
}

const clock24 = (ms: number): string => {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * The clock, `size` px square, showing `now` on its hands and `dots` on its rim. The hands carry the classes
 * `hh`, `mh` and `sh` and sit at their angle through a `transform`, which the page rewrites as time passes.
 */
export function shipClockSvg(now: number, dots: readonly Dot[], opts: ClockOptions = {}): string {
  const size = opts.size ?? 190
  const format = opts.format ?? clock24
  const angles = handAngles(clockTime(now))
  const summary = describeHour(summarize(dots.map(d => d.pr), now))

  const sweep = sweepPaths(angles.minute)
  const [thisHour, lastHour] = hourShades(clockTime(now).hours)
  let body = '<circle class="face" cx="100" cy="100" r="95"/>'
  // The dial is shaded in two colours: the part the minute hand has swept this hour, and the rest, which keeps
  // last hour's colour. They swap every hour, so a dot in the older shade was opened the hour before.
  body += `<path class="sw-rest" d="${sweep.rest}" style="fill:var(${lastHour},${SHADE_FALLBACK[lastHour]});fill-opacity:.22"/>`
  body += `<path class="sw-done" d="${sweep.done}" style="fill:var(${thisHour},${SHADE_FALLBACK[thisHour]});fill-opacity:.32"/>`
  for (let i = 0; i < 60; i++) {
    if (i % 5 === 0) continue
    const [x1, y1] = point(i * 6, 90)
    const [x2, y2] = point(i * 6, 93)
    body += `<line class="tick" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`
  }
  for (let h = 0; h < 12; h++) {
    const [x1, y1] = point(h * 30, 86)
    const [x2, y2] = point(h * 30, 93)
    body += `<line class="mark" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`
  }
  for (const d of dots) {
    const [cx, cy] = point(d.angle, trackRadius(d.track))
    const color = DOT_COLOR[d.status]
    const hollow = d.status === 'draft'
    const tip = `#${d.pr.number} ${d.pr.repo}: ${d.pr.title} (opened ${format(Date.parse(d.pr.createdAt))}, ${DOT_LABEL[d.status]})`
    body +=
      `<circle class="dot" cx="${r1(cx)}" cy="${r1(cy)}" r="${d.status === 'closed' ? 4.5 : 6}" ` +
      (hollow ? `fill="none" stroke="${color}" stroke-width="2.5"` : `fill="${color}" stroke="#fff" stroke-opacity=".7" stroke-width="1"`) +
      `><title>${esc(tip)}</title></circle>`
  }
  body += `<g class="hh" transform="rotate(${r1(angles.hour)} 100 100)">${hand('hh', 46, 8, 6)}</g>`
  body += `<g class="mh" transform="rotate(${r1(angles.minute)} 100 100)">${hand('mh', 66, 10, 4)}</g>`
  if (opts.seconds ?? true) body += `<g class="sh" transform="rotate(${r1(angles.second)} 100 100)">${hand('sh', 74, 16, 1.6)}</g>`
  body += '<circle cx="100" cy="100" r="5" fill="#8b929c"/><circle cx="100" cy="100" r="2" fill="#fff" fill-opacity=".9"/>'

  const label = esc(summary)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200" role="img" aria-label="${label}">${STYLE}<title>${label}</title>${body}</svg>`
}

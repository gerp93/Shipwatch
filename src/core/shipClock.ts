// The ship clock: an analog clock whose hands are driven by the board instead of the time of day. Pure text
// in, text out, like charts.ts, so a web report or an app embeds the same markup.
//
//   hour hand    points at the repo that most needs you (failing, then building, then ready, then
//                awaiting release); the twelve hour marks are the repos that need attention, most urgent
//                first, each coloured by its state
//   minute hand  how far that repo is through the stepper: PR, Build, Merged, Released (a full turn is
//                released; a build in progress counts as half a step)
//   second hand  sweeps once a minute; red while a build is failing, amber while one is running, green when
//                something is ready to merge, grey when there is nothing to watch
//
// Only the second hand moves on its own (an SVG animation, so the page needs no script for it); the other
// two change when the report is regenerated.

import type { Level, RepoView } from './types'

/** The levels that earn an hour mark: a repo that is draft-only, quiet or stale does not. */
const ACTIVE: Level[] = ['fail', 'running', 'ready', 'pending']

const LEVEL_RANK: Record<Level, number> = { fail: 0, running: 1, ready: 2, pending: 3, draft: 4, idle: 5 }

/** Mid-tones that read on a light or a dark background, matching the report's level colours. */
export const CLOCK_COLOR: Record<Level, string> = {
  fail: '#e5534b',
  running: '#d9a520',
  ready: '#3fa66b',
  pending: '#8a7bd8',
  draft: '#8b929c',
  idle: '#8b929c',
}

export type ClockSlot = { name: string; level: Level; headline: string }

export type ClockModel = {
  /** Repos that need attention, most urgent first; at most twelve, one per hour mark. */
  slots: ClockSlot[]
  /** Repos that need attention but did not fit on the dial. */
  extra: number
  /** Index into `slots` the hour hand points at; -1 when there is nothing to watch. */
  focus: number
  /** Degrees clockwise from 12. */
  hourAngle: number
  minuteAngle: number
  /** What the second hand shows: the most urgent state on the board. */
  tone: Level
}

const stepProgress = (steps: RepoView['steps']): number => {
  let done = 0
  for (const s of steps) {
    if (s === 'done') done += 1
    else if (s === 'running') done += 0.5
  }
  return done / steps.length
}

/** What the hands show for `repos`. */
export function shipClockModel(repos: readonly RepoView[]): ClockModel {
  const active = repos
    .filter(r => ACTIVE.includes(r.level) && !r.isStale)
    .sort(
      (a, b) =>
        LEVEL_RANK[a.level] - LEVEL_RANK[b.level] ||
        (Date.parse(b.pushedAt) || 0) - (Date.parse(a.pushedAt) || 0) ||
        a.name.localeCompare(b.name),
    )
  const shown = active.slice(0, 12)
  if (shown.length === 0) return { slots: [], extra: 0, focus: -1, hourAngle: 0, minuteAngle: 0, tone: 'idle' }
  const lead = shown[0]!
  // A runner outage is not the code's fault, so it must not turn the second hand red on its own.
  const real = active.find(r => r.level === 'fail' && !r.isInfra)
  return {
    slots: shown.map(r => ({ name: r.name, level: r.level, headline: r.headline })),
    extra: active.length - shown.length,
    focus: 0,
    hourAngle: 0,
    minuteAngle: Math.round(stepProgress(lead.steps) * 360 * 10) / 10,
    tone: real ? 'fail' : (active.find(r => r.level !== 'fail')?.level ?? 'idle'),
  }
}

/** One line saying what the clock shows, for a label and a tooltip. */
export function describeShipClock(model: ClockModel): string {
  if (model.slots.length === 0) return 'Nothing needs attention'
  const count = (level: Level): number => model.slots.filter(s => s.level === level).length
  const parts = [
    count('fail') && `${count('fail')} failing`,
    count('running') && `${count('running')} building`,
    count('ready') && `${count('ready')} ready to merge`,
    count('pending') && `${count('pending')} awaiting release`,
  ].filter(Boolean)
  const lead = model.slots[model.focus]!
  return `${parts.join(', ')}. Hour hand: ${lead.name} (${lead.headline})`
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const r1 = (n: number): string => String(Math.round(n * 10) / 10)

const point = (angle: number, radius: number): [number, number] => {
  const a = (angle * Math.PI) / 180
  return [100 + Math.sin(a) * radius, 100 - Math.cos(a) * radius]
}

const hand = (angle: number, length: number, tail: number, width: number, cls: string, color?: string): string => {
  const [x2, y2] = point(angle, length)
  const [x1, y1] = point(angle + 180, tail)
  return `<line class="${cls}" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}" stroke-width="${width}" stroke-linecap="round"${color ? ` stroke="${color}"` : ''}/>`
}

const STYLE =
  '<style>.face{fill:#8b929c;fill-opacity:.1;stroke:#8b929c;stroke-opacity:.6;stroke-width:3}' +
  '.min{stroke:#8b929c;stroke-opacity:.45;stroke-width:1}.mark{stroke:#8b929c;stroke-opacity:.8;stroke-width:2}' +
  '.mh{stroke:#1f2328}@media (prefers-color-scheme:dark){.mh{stroke:#e6edf3}}</style>'

/**
 * The clock, `size` px square. `now` (epoch ms) sets where the second hand starts; with `animate` it then
 * keeps sweeping, otherwise it stays put (for people who ask for reduced motion, and for tests).
 */
export function shipClockSvg(model: ClockModel, now: number, opts: { size?: number; animate?: boolean } = {}): string {
  const size = opts.size ?? 160
  const animate = opts.animate ?? true
  const label = esc(describeShipClock(model))
  const tone = CLOCK_COLOR[model.tone]
  const lead = model.focus >= 0 ? model.slots[model.focus] : undefined

  let body = '<circle class="face" cx="100" cy="100" r="94"/>'
  for (let i = 0; i < 60; i++) {
    if (i % 5 === 0) continue
    const [x1, y1] = point(i * 6, 86)
    const [x2, y2] = point(i * 6, 90)
    body += `<line class="min" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`
  }
  for (let h = 0; h < 12; h++) {
    const slot = model.slots[h]
    if (slot) {
      const [cx, cy] = point(h * 30, 80)
      const focused = h === model.focus
      body +=
        `<circle cx="${r1(cx)}" cy="${r1(cy)}" r="${focused ? 9 : 7}" fill="${CLOCK_COLOR[slot.level]}"` +
        `${focused ? ' stroke="#fff" stroke-opacity=".85" stroke-width="2"' : ''}><title>${esc(slot.name)} · ${esc(slot.headline)}</title></circle>`
    } else {
      const [x1, y1] = point(h * 30, 76)
      const [x2, y2] = point(h * 30, 90)
      body += `<line class="mark" x1="${r1(x1)}" y1="${r1(y1)}" x2="${r1(x2)}" y2="${r1(y2)}"/>`
    }
  }
  body += hand(model.hourAngle, 48, 8, 6, 'hh', lead ? CLOCK_COLOR[lead.level] : '#8b929c')
  body += hand(model.minuteAngle, 68, 10, 4, 'mh')

  const start = (((now % 60_000) + 60_000) % 60_000) / 60_000 * 360
  const second = hand(0, 76, 18, 1.8, 'sh', tone)
  body += animate
    ? second.replace(
        '/>',
        `><animateTransform attributeName="transform" type="rotate" from="${r1(start)} 100 100" to="${r1(start + 360)} 100 100" dur="60s" repeatCount="indefinite"/></line>`,
      )
    : second.replace('/>', ` transform="rotate(${r1(start)} 100 100)"/>`)
  body += `<circle cx="100" cy="100" r="6" fill="${tone}"/><circle cx="100" cy="100" r="2" fill="#fff" fill-opacity=".9"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 200 200" role="img" aria-label="${label}">${STYLE}<title>${label}</title>${body}</svg>`
}

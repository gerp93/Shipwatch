// The ship clock's place on the dashboard: a real clock whose rim marks the minute each PR was opened in the last
// hour, and beside it a list of those PRs with where each stands. The clock keeps its own time (the hands move
// every second and a dot drops off the rim when its hour is up); the PRs come from the page's data, and the host
// can replace them while the page is open. Kept out of client.ts so the page script only has to ask for it.
// Bundled with the rest by scripts/build-report.mjs.

import { DOT_COLOR, DOT_LABEL, SHADE_FALLBACK, clockTime, describeHour, dotStatus, dotsFor, handAngles, hourShades, inWindow, shipClockSvg, summarize, sweepPaths, type DotStatus } from '../core/shipClock'
import type { RecentPr } from '../core/types'

const node = (tag: string, style: string, text = ''): HTMLElement => {
  const n = document.createElement(tag)
  if (style) n.setAttribute('style', style)
  if (text) n.textContent = text
  return n
}

const clock24 = (ms: number): string => {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** How many PRs the list beside the clock shows before saying how many more there are. */
const LIST_MAX = 10

/** The statuses in the colour key, in the order a PR moves through them, then the ones that end differently. */
const KEY_ORDER: DotStatus[] = ['building', 'ready', 'failing', 'open', 'draft', 'merged', 'released', 'closed']

/** One entry of the colour key: a swatch drawn like the dot (a draft is hollow, a closed PR a little smaller) and what it means. */
const keyEntry = (swatch: HTMLElement, label: string): HTMLElement => {
  const entry = node('span', 'display:inline-flex;align-items:center;gap:5px;white-space:nowrap')
  entry.append(swatch, document.createTextNode(label))
  return entry
}

const dotSwatch = (status: DotStatus): HTMLElement => {
  const size = status === 'closed' ? 9 : 12
  const fill = status === 'draft' ? `border:2.5px solid ${DOT_COLOR[status]}` : `background:${DOT_COLOR[status]}`
  return node('span', `display:inline-block;box-sizing:border-box;width:${size}px;height:${size}px;border-radius:50%;${fill}`)
}

const shadeSwatch = (shade: '--clock-a' | '--clock-b', opacity: number): HTMLElement =>
  node('span', `display:inline-block;width:14px;height:12px;border-radius:3px;border:1px solid var(--line);background:var(${shade},${SHADE_FALLBACK[shade]});opacity:${opacity}`)

/** What every colour on the clock means: the dots by where a PR stands, and the dial's two shades by which hour it was opened in. */
function colourKey(now: number): HTMLElement {
  const [thisHour, lastHour] = hourShades(clockTime(now).hours)
  const key = node('div', 'color:var(--dim);margin-top:8px;font-size:12px')
  key.setAttribute('aria-label', 'Colour key')
  const row = (title: string, entries: HTMLElement[]): void => {
    const line = node('div', 'display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px')
    line.append(node('span', 'font-weight:600', title), ...entries)
    key.append(line)
  }
  row('Dots:', KEY_ORDER.map(status => keyEntry(dotSwatch(status), DOT_LABEL[status])))
  row('Dial:', [keyEntry(shadeSwatch(thisHour, 0.6), 'this hour so far'), keyEntry(shadeSwatch(lastHour, 0.45), 'the hour before')])
  return key
}

/** What the panel currently draws from; the page can point it at fresh data. */
let source: () => RecentPr[] | undefined = () => undefined
let timer: number | undefined

/** What would change the picture: the PRs in the window and where each stands, and which hour it is (the two shades swap each hour). */
const signature = (prs: readonly RecentPr[], now: number): string => `${prs.map(p => `${p.repo}#${p.number}:${p.state}:${p.checks}:${p.parked}`).join('|')}@${clockTime(now).hours}`

const reduceMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Draws the dial and the list for the PRs in the window as of now. */
function render(panel: HTMLElement): void {
  const now = Date.now()
  const known = source()
  const recent = known === undefined ? undefined : inWindow(known, now)
  panel.dataset.sig = signature(recent ?? [], now)
  panel.replaceChildren()

  const dial = node('div', 'flex:none;line-height:0')
  dial.innerHTML = shipClockSvg(now, dotsFor(recent ?? [], now), { size: 190, seconds: !reduceMotion(), format: clock24 })
  panel.append(dial)

  const key = node('div', 'flex:1;min-width:240px')
  key.append(node('div', 'font-weight:600', 'Last hour'))
  if (recent === undefined) {
    key.append(node('div', 'color:var(--dim)', 'The last hour of PRs is not part of this report.'))
  } else {
    key.append(node('div', 'color:var(--dim);margin-bottom:6px', describeHour(summarize(recent, now))))
    for (const pr of recent.slice(0, LIST_MAX)) {
      const status = dotStatus(pr)
      const line = node('div', 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis')
      line.append(node('span', `display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:${DOT_COLOR[status]}`))
      line.append(node('span', 'color:var(--dim);margin-right:8px', clock24(Date.parse(pr.createdAt))))
      const label = `${pr.repo} #${pr.number}`
      if (pr.url.startsWith('https://')) {
        const a = document.createElement('a')
        a.href = pr.url
        a.target = '_blank'
        a.rel = 'noopener'
        a.textContent = label
        line.append(a)
      } else {
        line.append(document.createTextNode(label))
      }
      line.append(document.createTextNode(` ${pr.title}`))
      line.append(node('span', 'color:var(--dim)', ` · ${DOT_LABEL[status]}`))
      key.append(line)
    }
    if (recent.length > LIST_MAX) key.append(node('div', 'color:var(--dim)', `+${recent.length - LIST_MAX} more`))
  }
  key.append(colourKey(now))
  key.append(node('div', 'color:var(--dim);margin-top:6px;font-size:12px', 'The hands show the time. A dot on the rim marks the minute a PR was opened, for the last 60 minutes, coloured by where it stands now. The dial is shaded in two colours that swap each hour, so a dot in the older shade was opened the hour before.'))
  panel.append(key)
}

const rotate = (panel: HTMLElement, selector: string, angle: number): void => {
  panel.querySelector(selector)?.setAttribute('transform', `rotate(${Math.round(angle * 10) / 10} 100 100)`)
}

/** Once a second: move the hands, and redraw when a PR has dropped off the rim or one has arrived or changed. */
function tick(): void {
  const panel = document.querySelector<HTMLElement>('.ship-clock')
  if (!panel) return // the Stats tab is showing
  const now = Date.now()
  const known = source()
  const sig = signature(known === undefined ? [] : inWindow(known, now), now)
  if (sig !== panel.dataset.sig) {
    render(panel)
    return
  }
  const a = handAngles(clockTime(now))
  rotate(panel, 'g.hh', a.hour)
  rotate(panel, 'g.mh', a.minute)
  rotate(panel, 'g.sh', a.second)
  // The shading follows the minute hand round the dial.
  const sweep = sweepPaths(a.minute)
  panel.querySelector('path.sw-done')?.setAttribute('d', sweep.done)
  panel.querySelector('path.sw-rest')?.setAttribute('d', sweep.rest)
}

/** The panel for the dashboard. `recent` says which PRs to draw, and is asked again whenever the clock redraws. */
export function clockPanel(recent: () => RecentPr[] | undefined): HTMLElement {
  source = recent
  const panel = node('div', 'display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:8px 0 16px;padding:12px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card)')
  panel.setAttribute('class', 'ship-clock')
  render(panel)
  timer ??= window.setInterval(tick, 1000)
  return panel
}

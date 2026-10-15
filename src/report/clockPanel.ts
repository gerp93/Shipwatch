// The ship clock's place on the dashboard: the clock itself, and beside it what each hour mark is. Kept out
// of client.ts so the page script only has to ask for it. Bundled with the rest by scripts/build-report.mjs.

import { CLOCK_COLOR, describeShipClock, shipClockModel, shipClockSvg } from '../core/shipClock'
import type { RepoView } from '../core/types'

const node = (tag: string, style: string, text = ''): HTMLElement => {
  const n = document.createElement(tag)
  if (style) n.setAttribute('style', style)
  if (text) n.textContent = text
  return n
}

/** The clock for `repos`, with a key: one line per hour mark, the one the hour hand is on first and bold. */
export function clockPanel(repos: readonly RepoView[]): HTMLElement {
  const model = shipClockModel(repos)
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

  const panel = node('div', 'display:flex;gap:20px;align-items:center;flex-wrap:wrap;margin:8px 0 16px;padding:12px 16px;border:1px solid var(--line);border-radius:8px;background:var(--card)')
  panel.setAttribute('class', 'ship-clock')

  const dial = node('div', 'flex:none;line-height:0')
  dial.innerHTML = shipClockSvg(model, Date.now(), { size: 150, animate: !reduceMotion })
  panel.append(dial)

  const key = node('div', 'flex:1;min-width:220px')
  key.append(node('div', 'font-weight:600', model.slots.length === 0 ? 'Nothing to watch' : 'Ship clock'))
  key.append(node('div', 'color:var(--dim);margin-bottom:6px', describeShipClock(model)))
  model.slots.forEach((slot, i) => {
    const line = node('div', `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${i === model.focus ? 'font-weight:600' : ''}`)
    line.append(node('span', `display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:8px;background:${CLOCK_COLOR[slot.level]}`))
    line.append(document.createTextNode(`${i + 1} · ${slot.name}`))
    line.append(node('span', 'color:var(--dim)', ` ${slot.headline}`))
    key.append(line)
  })
  if (model.extra > 0) key.append(node('div', 'color:var(--dim)', `+${model.extra} more not on the dial`))
  key.append(node('div', 'color:var(--dim);margin-top:6px;font-size:12px', 'Hour hand: the repo that most needs you. Minute hand: how far it is from PR to release. Second hand: the board’s worst state.'))
  panel.append(key)
  return panel
}

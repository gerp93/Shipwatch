// The Stats charts, drawn as SVG strings. Pure text in, text out: the Claude pane hands them to its `Svg`
// element, and a web report or an app can embed the same markup, so every outlet draws the same picture.
//
// Colours are fixed mid-tones that read on a light or a dark background; labels take their colour from a
// small stylesheet that follows `prefers-color-scheme`. Every mark carries a <title>, which an interactive
// SVG shows as a hover tooltip.

import { ALL_AI, AUTOMATION, MIXED, OTHERS, YOU } from './stats'

export type ChartPart = { label: string; value: number; color: string }

const AI_PALETTE = ['#4c8dff', '#d9a520', '#2fb8c4', '#e5534b', '#8a7bd8']
const GREY = '#8b929c'

/** The SVG limit the Claude engine enforces on one drawing. */
const MAX_SOURCE = 131072

/** The hex colour an actor is drawn in; matches the terminal colours the text view uses. */
export function chartColor(actor: string, ais: readonly string[]): string {
  if (actor === YOU) return '#3fa66b'
  if (actor === ALL_AI) return '#c061cb'
  if (actor === OTHERS || actor === AUTOMATION || actor === MIXED) return GREY
  const i = ais.indexOf(actor)
  return AI_PALETTE[(i < 0 ? 0 : i) % AI_PALETTE.length]!
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const num = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)
const round = (n: number): string => String(Math.round(n * 100) / 100)

const STYLE =
  '<style>text{font:12px system-ui,sans-serif;fill:#4b5563}.strong{fill:#111827;font-weight:600}.dim{fill:#6b7280}' +
  '@media (prefers-color-scheme:dark){text{fill:#c5cad3}.strong{fill:#f3f4f6}.dim{fill:#9ca3af}}' +
  'rect.m:hover,circle.m:hover{opacity:.8}</style>'

const svg = (width: number, height: number, body: string): string => {
  const out = `<svg xmlns="http://www.w3.org/2000/svg" width="${round(width)}" height="${round(height)}" viewBox="0 0 ${round(width)} ${round(height)}" role="img">${STYLE}${body}</svg>`
  return out.length > MAX_SOURCE ? '' : out
}

const percent = (value: number, total: number): string => (total > 0 ? `${Math.round((value / total) * 100)}%` : '0%')

/**
 * A ring split by `parts`, with `center` large and `sub` small inside it. A part's tooltip gives its
 * value and share.
 */
export function donutSvg(parts: ChartPart[], center: string, sub: string, size = 150): string {
  const live = parts.filter(p => num(p.value) > 0)
  const total = live.reduce((n, p) => n + p.value, 0)
  const stroke = Math.round(size * 0.16)
  const r = (size - stroke) / 2
  const c = size / 2
  const len = 2 * Math.PI * r
  let offset = 0
  const arcs =
    total === 0
      ? `<circle cx="${c}" cy="${c}" r="${round(r)}" fill="none" stroke="${GREY}" stroke-opacity=".3" stroke-width="${stroke}"/>`
      : live
          .map(p => {
            const share = (p.value / total) * len
            const arc =
              `<circle class="m" cx="${c}" cy="${c}" r="${round(r)}" fill="none" stroke="${p.color}" stroke-width="${stroke}" ` +
              `stroke-dasharray="${round(share)} ${round(len - share)}" stroke-dashoffset="${round(-offset)}" ` +
              `transform="rotate(-90 ${c} ${c})"><title>${esc(p.label)}: ${p.value.toLocaleString('en-US')} (${percent(p.value, total)})</title></circle>`
            offset += share
            return arc
          })
          .join('')
  const text =
    `<text class="strong" x="${c}" y="${c + 2}" text-anchor="middle" style="font-size:${Math.round(size * 0.19)}px">${esc(center)}</text>` +
    `<text class="dim" x="${c}" y="${c + Math.round(size * 0.14) + 2}" text-anchor="middle">${esc(sub)}</text>`
  return svg(size, size, arcs + text)
}

/** Dots and names for the actors in a chart, in a row that wraps at `width`. */
export function legendSvg(parts: Array<{ label: string; color: string }>, width = 360): string {
  let x = 0
  let y = 10
  let body = ''
  for (const p of parts) {
    const w = 22 + p.label.length * 7 + 14
    if (x > 0 && x + w > width) {
      x = 0
      y += 20
    }
    body += `<circle cx="${x + 5}" cy="${y}" r="5" fill="${p.color}"/><text x="${x + 15}" y="${y + 4}">${esc(p.label)}</text>`
    x += w
  }
  return svg(width, y + 12, body)
}

export type BarRow = { label: string; parts: ChartPart[]; note?: string }

/**
 * One horizontal stacked bar per row, all on the same scale (the longest row fills the width), with the
 * row's total at the end of its bar.
 */
export function barsSvg(rows: BarRow[], width = 520): string {
  if (rows.length === 0) return ''
  const labelW = Math.min(170, Math.max(60, ...rows.map(r => r.label.length * 7 + 8)))
  const noteW = 70
  const trackW = Math.max(60, width - labelW - noteW - 8)
  const rowH = 22
  const totals = rows.map(r => r.parts.reduce((n, p) => n + num(p.value), 0))
  const peak = Math.max(1, ...totals)
  let body = ''
  rows.forEach((row, i) => {
    const y = i * rowH + 3
    body += `<text x="0" y="${y + 13}">${esc(row.label.length > 24 ? `${row.label.slice(0, 23)}…` : row.label)}</text>`
    let x = labelW
    for (const p of row.parts) {
      const w = (num(p.value) / peak) * trackW
      if (w <= 0) continue
      body += `<rect class="m" x="${round(x)}" y="${y}" width="${round(Math.max(1, w))}" height="16" rx="2" fill="${p.color}"><title>${esc(row.label)} · ${esc(p.label)}: ${p.value.toLocaleString('en-US')}</title></rect>`
      x += w
    }
    body += `<text class="dim" x="${round(x + 6)}" y="${y + 13}">${esc(row.note ?? String(totals[i]))}</text>`
  })
  return svg(width, rows.length * rowH + 4, body)
}

export type WeekColumn = { label: string; parts: ChartPart[] }

/** Stacked columns, one per week, oldest left, with a faint baseline and the peak marked. */
export function weeksSvg(weeks: WeekColumn[], width = 520, height = 150): string {
  if (weeks.length === 0) return ''
  const top = 16
  const bottom = 22
  const plotH = height - top - bottom
  const slot = width / weeks.length
  const barW = Math.max(4, Math.min(34, slot * 0.7))
  const totals = weeks.map(w => w.parts.reduce((n, p) => n + num(p.value), 0))
  const peak = Math.max(1, ...totals)
  let body = `<line x1="0" y1="${top + plotH}" x2="${width}" y2="${top + plotH}" stroke="${GREY}" stroke-opacity=".4"/>`
  body += `<text class="dim" x="0" y="10">peak ${peak}</text>`
  weeks.forEach((w, i) => {
    const x = i * slot + (slot - barW) / 2
    let y = top + plotH
    for (const p of w.parts) {
      const h = (num(p.value) / peak) * plotH
      if (h <= 0) continue
      y -= h
      body += `<rect class="m" x="${round(x)}" y="${round(y)}" width="${round(barW)}" height="${round(h)}" fill="${p.color}"><title>Week of ${esc(w.label)} · ${esc(p.label)}: ${p.value}</title></rect>`
    }
    // Label about every fourth week so they never collide.
    if (i % Math.max(1, Math.ceil(weeks.length / 6)) === 0) {
      body += `<text class="dim" x="${round(x + barW / 2)}" y="${height - 6}" text-anchor="middle">${esc(w.label)}</text>`
    }
  })
  return svg(width, height, body)
}

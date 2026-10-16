import { expect, test } from 'claude-code/testing'

import { barsSvg, chartColor, donutSvg, legendSvg, linesSvg, weeksSvg } from './charts'
import { ALL_AI, OTHERS, YOU } from './stats'

const parts = [
  { label: 'You', value: 5, color: chartColor(YOU, []) },
  { label: 'Claude', value: 95, color: chartColor('Claude', ['Claude']) },
]

test('each AI gets its own colour and You, the combined AI and everyone else are fixed', () => {
  const ais = ['Claude', 'Cursor']
  expect(chartColor('Claude', ais)).not.toBe(chartColor('Cursor', ais))
  expect(chartColor(YOU, ais)).not.toBe(chartColor(ALL_AI, ais))
  expect(chartColor(OTHERS, ais)).toBe('#8b929c')
  const humans = ['@grant', '@sam']
  expect(chartColor('@grant', ais, humans)).not.toBe(chartColor('@sam', ais, humans))
  expect(humans.map(h => chartColor(h, ais, humans))).not.toContain(chartColor(YOU, ais))
})

test('the donut has one arc per part with a tooltip giving its share, and says the total inside', () => {
  const s = donutSvg(parts, '95%', 'Claude')
  expect(s.startsWith('<svg')).toBe(true)
  expect(s).toContain('Claude: 95 (95%)')
  expect(s).toContain('You: 5 (5%)')
  expect(s).toContain('>95%<')
  expect(s.match(/<circle class="m"/g)?.length).toBe(2)
})

test('an empty donut is a plain ring, not a division by zero', () => {
  const s = donutSvg([{ label: 'You', value: 0, color: '#000' }], '0%', 'nothing yet')
  expect(s).not.toContain('NaN')
  expect(s).not.toContain('class="m"')
})

test('bars share one scale, so a smaller row draws a shorter bar', () => {
  const s = barsSvg([
    { label: 'big', parts: [{ label: 'You', value: 100, color: '#111' }] },
    { label: 'small', parts: [{ label: 'You', value: 10, color: '#111' }] },
  ])
  const widths = [...s.matchAll(/<rect class="m"[^>]* width="([\d.]+)"/g)].map(m => Number(m[1]))
  expect(widths.length).toBe(2)
  expect(widths[0]!).toBeGreaterThan(widths[1]! * 5)
  expect(barsSvg([])).toBe('')
})

test('weekly columns stack and name their week in the tooltip', () => {
  const s = weeksSvg([
    { label: '09-14', parts: parts },
    { label: '09-21', parts: [{ label: 'You', value: 2, color: '#111' }] },
  ])
  expect(s).toContain('Week of 09-14 · Claude: 95')
  expect(s).toContain('peak 100')
  expect(s).not.toContain('NaN')
  expect(weeksSvg([])).toBe('')
})

test('text from GitHub is escaped, and the legend wraps', () => {
  const s = barsSvg([{ label: '<script>x</script>', parts: [{ label: 'a&b', value: 1, color: '#111' }] }])
  expect(s).not.toContain('<script>')
  expect(s).toContain('a&amp;b')
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `Assistant ${i}`, color: '#111' }))
  expect(legendSvg(many, 300).match(/<circle/g)?.length).toBe(12)
})

test('the line chart draws one line per series that has data, with a tooltip on every point and a round axis', () => {
  const labels = ['2026-10-01', '2026-10-02', '2026-10-03']
  const s = linesSvg(labels, [
    { label: 'You', color: '#3fa66b', values: [0, 4, 2] },
    { label: 'Claude', color: '#c061cb', values: [1, 8, 3] },
    { label: 'Other humans', color: '#8b929c', values: [0, 0, 0] },
  ])
  expect(s.match(/<polyline/g)?.length).toBe(2) // the all-zero series is left out
  expect(s).toContain('<title>2026-10-02 · Claude: 8 commits</title>')
  expect(s).toContain('>8</text>') // the top of the axis, a round number
  expect(s).toContain('>4</text>') // its midpoint, a whole number too
  expect(s).not.toContain('NaN')
  expect(linesSvg([], [])).toBe('')
  expect(linesSvg(labels, [{ label: 'x', color: '#111', values: [0, 0, 0] }])).toBe('')
})

test('line chart text from GitHub is escaped', () => {
  const s = linesSvg(['<b>'], [{ label: 'a&b', color: '#111', values: [3] }])
  expect(s).not.toContain('<b>')
  expect(s).toContain('a&amp;b')
})

test('the first and last labels of the weekly chart stay inside the drawing', () => {
  const cols = Array.from({ length: 60 }, (_, i) => ({ label: `2015-${String((i % 12) + 1).padStart(2, '0')}`, parts: [{ label: 'You', value: 1, color: '#3fa66b' }] }))
  const s = weeksSvg(cols, 760, 170)
  expect(s).toContain('text-anchor="start">2015-01</text>')
})

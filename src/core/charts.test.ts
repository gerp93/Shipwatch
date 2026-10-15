import { expect, test } from 'claude-code/testing'

import { barsSvg, chartColor, donutSvg, legendSvg, weeksSvg } from './charts'
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

import { expect, test } from 'claude-code/testing'

import { CLOCK_COLOR, describeShipClock, shipClockModel, shipClockSvg } from './shipClock'
import type { Level, RepoView, StepState } from './types'

const repo = (name: string, level: Level, steps: RepoView['steps'], extra: Partial<RepoView> = {}): RepoView => ({
  name,
  url: `https://github.com/o/${name}`,
  pushedAt: '2026-10-10T00:00:00Z',
  headChecks: 'none',
  headDate: '',
  branch: 'main',
  headOid: '',
  release: null,
  prs: [],
  activity: [],
  steps,
  level,
  headline: `${name} headline`,
  isStale: false,
  isInfra: false,
  ...extra,
})

const S = (a: StepState, b: StepState, c: StepState, d: StepState): RepoView['steps'] => [a, b, c, d]

test('the hour hand sits on the most urgent repo, and the hour marks run from most to least urgent', () => {
  const m = shipClockModel([
    repo('ready-one', 'ready', S('done', 'done', 'todo', 'todo')),
    repo('failing-one', 'fail', S('done', 'failed', 'todo', 'todo')),
    repo('building-one', 'running', S('done', 'running', 'todo', 'todo')),
  ])
  expect(m.slots.map(s => s.name)).toEqual(['failing-one', 'building-one', 'ready-one'])
  expect(m.focus).toBe(0)
  expect(m.hourAngle).toBe(0)
})

test('the minute hand is how far the lead repo is through the stepper, a running step counting as half', () => {
  const at = (steps: RepoView['steps']) => shipClockModel([repo('a', 'running', steps)]).minuteAngle
  expect(at(S('done', 'todo', 'todo', 'todo'))).toBe(90)
  expect(at(S('done', 'running', 'todo', 'todo'))).toBe(135)
  expect(at(S('done', 'done', 'done', 'todo'))).toBe(270)
  // A failed step stops the hand where the repo got to.
  expect(at(S('done', 'failed', 'todo', 'todo'))).toBe(90)
})

test('draft-only, quiet and stale repos do not earn an hour mark; with none, the clock says there is nothing to watch', () => {
  const m = shipClockModel([
    repo('draft', 'draft', S('done', 'todo', 'todo', 'todo')),
    repo('quiet', 'idle', S('done', 'done', 'done', 'done')),
    repo('old', 'fail', S('done', 'failed', 'todo', 'todo'), { isStale: true }),
  ])
  expect(m.slots.length).toBe(0)
  expect(m.focus).toBe(-1)
  expect(m.tone).toBe('idle')
  expect(describeShipClock(m)).toBe('Nothing needs attention')
})

test('the second hand is red for a real failure, but a runner outage alone does not turn it red', () => {
  const failing = repo('a', 'fail', S('done', 'failed', 'todo', 'todo'))
  const outage = repo('b', 'fail', S('done', 'failed', 'todo', 'todo'), { isInfra: true })
  const building = repo('c', 'running', S('done', 'running', 'todo', 'todo'))
  expect(shipClockModel([failing, building]).tone).toBe('fail')
  expect(shipClockModel([outage, building]).tone).toBe('running')
  expect(shipClockModel([outage]).tone).toBe('idle')
})

test('more than twelve repos fill the dial and count the rest', () => {
  const many = Array.from({ length: 15 }, (_, i) => repo(`r${i}`, 'ready', S('done', 'done', 'todo', 'todo')))
  const m = shipClockModel(many)
  expect(m.slots.length).toBe(12)
  expect(m.extra).toBe(3)
})

test('the drawing has one dot per repo with a tooltip, a sweeping second hand, and escapes repo names', () => {
  const m = shipClockModel([repo('<b>x</b>', 'fail', S('done', 'failed', 'todo', 'todo')), repo('y', 'running', S('done', 'running', 'todo', 'todo'))])
  const s = shipClockSvg(m, 12_345)
  expect(s.startsWith('<svg')).toBe(true)
  expect(s).not.toContain('<b>x</b>')
  expect(s).toContain('&lt;b&gt;x&lt;/b&gt;')
  expect(s).toContain(`fill="${CLOCK_COLOR.fail}"`)
  expect(s).toContain('<animateTransform')
  expect(s).not.toContain('NaN')
  // Reduced motion: the second hand is placed, not animated.
  expect(shipClockSvg(m, 12_345, { animate: false })).not.toContain('<animateTransform')
})

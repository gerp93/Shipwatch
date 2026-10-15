// The script inside the Shipwatch report page. It reads the data the page was generated with and draws the
// dashboard and the stats with filters, sorting and a drill-down per repo. All numbers and charts come from
// the core (aggregate, charts), the same code the Claude pane uses; this file is only the page around them.
//
// Bundled by scripts/build-report.mjs into src/core/reportClient.generated.ts. Do not import a host API.

import { barsSvg, chartColor, donutSvg, legendSvg, linesSvg, weeksSvg } from '../core/charts'
import type { ReportData } from '../core/report'
import { THEME_IDS } from '../core/themes.generated'
import { RANGES, YOU, actorLabel, aggregate, aisIn, bucketFor, commitSeries, compact, earliestKnown, rangeLabel, rangeSince, reposCreatedSince } from '../core/stats'
import type { Level, RepoView, StatsMode } from '../core/types'

const data = (window as unknown as { SHIPWATCH_DATA: ReportData }).SHIPWATCH_DATA

const LEVEL_ORDER: Record<Level, number> = { fail: 0, running: 1, ready: 2, pending: 3, draft: 4, idle: 5 }
const LEVEL_LABEL: Record<Level, string> = {
  fail: 'Failing',
  running: 'Building',
  ready: 'Ready to merge',
  pending: 'Awaiting release',
  draft: 'Draft only',
  idle: 'Quiet',
}
const STEP_NAMES = ['PR', 'Build', 'Merged', 'Released']

type Sort = { key: string; dir: 1 | -1 }

type State = {
  view: 'dashboard' | 'stats'
  range: (typeof RANGES)[number]
  mode: StatsMode
  hidden: string[]
  repo: string | null
  q: string
  level: Level | 'all'
  sort: Sort
  dashSort: Sort
}

const state: State = {
  view: data.board.repos.length > 0 ? 'dashboard' : 'stats',
  range: 365,
  mode: 'combined',
  hidden: [],
  repo: null,
  q: '',
  level: 'all',
  sort: { key: 'commits', dir: -1 },
  dashSort: { key: 'level', dir: 1 },
}

type Child = Node | string | null | false | undefined

const el = (tag: string, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElement => {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue
    if (k === 'class') node.className = String(v)
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v as EventListener)
    else node.setAttribute(k, String(v))
  }
  for (const kid of kids) if (kid) node.append(kid)
  return node
}

/** A chart: markup from the core's chart functions, which escape everything they were given. */
const raw = (html: string): HTMLElement => {
  const box = el('div', { class: 'svg' })
  box.innerHTML = html
  return box
}

const ago = (iso: string): string => {
  const ms = data.generatedAt - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${Math.max(1, m)}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

const button = (label: string, active: boolean, onclick: () => void): HTMLElement =>
  el('button', { class: active ? 'btn on' : 'btn', onclick }, label)

const th = (label: string, key: string, sort: Sort, set: (key: string) => void): HTMLElement =>
  el('th', { class: 'sortable', onclick: () => set(key) }, label + (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''))

const compare = (x: string | number, y: string | number): number => (x < y ? -1 : x > y ? 1 : 0)

// ---- Dashboard ---------------------------------------------------------------------------------------------

function dashboard(): HTMLElement {
  const needle = state.q.toLowerCase()
  const repos = data.board.repos.filter(r => (state.level === 'all' || r.level === state.level) && r.name.toLowerCase().includes(needle))
  const keyOf: Record<string, (r: RepoView) => string | number> = {
    level: r => LEVEL_ORDER[r.level],
    name: r => r.name.toLowerCase(),
    prs: r => r.prs.length,
    pushed: r => -Date.parse(r.pushedAt || '1970-01-01'),
  }
  const pick = keyOf[state.dashSort.key] ?? keyOf.level!
  repos.sort((a, b) => compare(pick(a), pick(b)) * state.dashSort.dir)

  const setSort = (key: string) => {
    state.dashSort = { key, dir: state.dashSort.key === key ? (-state.dashSort.dir as 1 | -1) : 1 }
    draw()
  }
  const counts = (Object.keys(LEVEL_ORDER) as Level[]).map(l => [l, data.board.repos.filter(r => r.level === l).length] as const)

  return el(
    'section',
    {},
    el(
      'div',
      { class: 'row wrap' },
      el('input', {
        class: 'search',
        placeholder: 'Filter repos',
        value: state.q,
        oninput: (e: Event) => {
          state.q = (e.target as HTMLInputElement).value
          drawKeepFocus('.search')
        },
      }),
      button(`All ${data.board.repos.length}`, state.level === 'all', () => ((state.level = 'all'), draw())),
      ...counts.filter(([, n]) => n > 0).map(([l, n]) => button(`${LEVEL_LABEL[l]} ${n}`, state.level === l, () => ((state.level = l), draw()))),
    ),
    el(
      'table',
      {},
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          th('Status', 'level', state.dashSort, setSort),
          th('Repo', 'name', state.dashSort, setSort),
          el('th', {}, 'Where it is'),
          th('Open PRs', 'prs', state.dashSort, setSort),
          th('Last push', 'pushed', state.dashSort, setSort),
        ),
      ),
      el(
        'tbody',
        {},
        ...repos.map(r =>
          el(
            'tr',
            { class: `lv-${r.level}` },
            el('td', {}, el('span', { class: `pill ${r.level}` }, r.isInfra ? 'Runner outage' : LEVEL_LABEL[r.level])),
            el('td', {}, el('a', { href: r.url, target: '_blank', rel: 'noopener' }, r.name), r.headline ? el('div', { class: 'dim' }, r.headline) : null),
            el('td', { class: 'where' }, el('div', { class: 'steps' }, ...r.steps.map((s, i) => el('span', { class: `step ${s}`, title: `${STEP_NAMES[i]}: ${s}` }, STEP_NAMES[i])))),
            el(
              'td',
              {},
              ...(r.prs.length
                ? r.prs.map(p =>
                    el('div', {}, el('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number}`), ` ${p.title}`, p.isDraft ? el('span', { class: 'dim' }, ' draft') : null),
                  )
                : [el('span', { class: 'dim' }, '-')]),
            ),
            el('td', { class: 'dim' }, ago(r.pushedAt)),
          ),
        ),
      ),
    ),
    repos.length === 0 ? el('p', { class: 'dim' }, 'No repos match.') : null,
  )
}

// ---- Stats -------------------------------------------------------------------------------------------------

/** Commits over time as one line per who, counted on the day their PR merged. */
function commitsOverTime(agg: ReturnType<typeof aggregate>, sinceMs: number, color: (actor: string) => string): HTMLElement {
  const spanDays = (data.generatedAt - sinceMs) / 86_400_000
  const bucket = bucketFor(spanDays)
  const actors = agg.actors.map(a => a.actor)
  const { labels, values } = commitSeries(agg.days, actors, bucket, sinceMs, data.generatedAt)
  const per = bucket === 'day' ? 'day' : bucket === 'week' ? 'week' : 'month'
  return el(
    'div',
    {},
    el('h3', {}, `Commits per ${per}`, el('span', { class: 'dim' }, ' · by the day their PR merged')),
    raw(linesSvg(labels, actors.map(a => ({ label: actorLabel(a), color: color(a), values: values[a] ?? [] })), 760, 210)),
  )
}

function stats(): HTMLElement {
  const s = data.stats
  const ais = aisIn(s.prs)
  const sinceMs = rangeSince(state.range, data.generatedAt, earliestKnown(s.repos, s.prs))
  const inScope = state.repo ? s.prs.filter(p => p.repo === state.repo) : s.prs
  const agg = aggregate(inScope, sinceMs, state.mode, state.hidden)
  const created = reposCreatedSince(s.repos, sinceMs)
  const sum = (pick: (a: (typeof agg.actors)[number]) => number) => agg.actors.reduce((n, a) => n + pick(a), 0)
  const commits = sum(a => a.commits)
  const you = agg.actors.find(a => a.actor === YOU)?.commits ?? 0
  const color = (a: string) => chartColor(a, ais)

  const setSort = (key: string) => {
    state.sort = { key, dir: state.sort.key === key ? (-state.sort.dir as 1 | -1) : -1 }
    draw()
  }
  const commitsOf = (r: (typeof agg.repos)[number]) => r.actors.reduce((n, a) => n + a.commits, 0)
  const keyOf: Record<string, (r: (typeof agg.repos)[number]) => string | number> = {
    repo: r => r.repo.toLowerCase(),
    prs: r => r.prs,
    commits: commitsOf,
    adds: r => r.actors.reduce((n, a) => n + a.adds, 0),
    dels: r => r.actors.reduce((n, a) => n + a.dels, 0),
    you: r => (r.actors.find(a => a.actor === YOU)?.commits ?? 0) / Math.max(1, commitsOf(r)),
  }
  const pick = keyOf[state.sort.key] ?? keyOf.commits!
  const repoRows = [...agg.repos].sort((a, b) => compare(pick(a), pick(b)) * state.sort.dir)

  const tile = (n: string, label: string) => el('div', { class: 'tile' }, el('div', { class: 'big' }, n), el('div', { class: 'dim' }, label))

  return el(
    'section',
    {},
    el(
      'div',
      { class: 'row wrap' },
      ...RANGES.map(d => button(rangeLabel(d), state.range === d, () => ((state.range = d), draw()))),
      el('span', { class: 'dim' }, `${new Date(sinceMs).toLocaleDateString()} to ${new Date(data.generatedAt).toLocaleDateString()}`),
    ),
    el(
      'div',
      { class: 'row wrap' },
      button(state.mode === 'combined' ? 'You vs all AI' : 'You vs each AI', true, () => ((state.mode = state.mode === 'combined' ? 'separate' : 'combined'), draw())),
      ...ais.map(ai =>
        button(`${state.hidden.includes(ai) ? '○' : '●'} ${ai}`, !state.hidden.includes(ai), () => {
          state.hidden = state.hidden.includes(ai) ? state.hidden.filter(h => h !== ai) : [...state.hidden, ai]
          draw()
        }),
      ),
    ),
    state.repo
      ? el('div', { class: 'row' }, el('span', { class: 'chip' }, `Repo: ${state.repo}`, el('button', { class: 'x', title: 'Show every repo', onclick: () => ((state.repo = null), draw()) }, '×')))
      : null,
    el(
      'div',
      { class: 'tiles' },
      tile(String(agg.prs), 'PRs merged'),
      tile(compact(commits), 'commits'),
      tile(`+${compact(sum(a => a.adds))} −${compact(sum(a => a.dels))}`, 'lines changed'),
      tile(String(created.length), 'repos created'),
    ),
    commits === 0 ? el('p', { class: 'dim' }, 'Nothing merged in this range.') : null,
    commits > 0
      ? el(
          'div',
          { class: 'row wrap top' },
          raw(donutSvg(agg.actors.map(a => ({ label: actorLabel(a.actor), value: a.commits, color: color(a.actor) })), `${Math.round((you / commits) * 100)}%`, 'You, by commits')),
          el(
            'div',
            {},
            raw(legendSvg(agg.actors.map(a => ({ label: actorLabel(a.actor), color: color(a.actor) })), 260)),
            el(
              'table',
              { class: 'compact' },
              el('thead', {}, el('tr', {}, el('th', {}, 'Who'), el('th', {}, 'Share'), el('th', {}, 'Commits'), el('th', {}, 'Lines'), el('th', {}, 'PRs'))),
              el(
                'tbody',
                {},
                ...agg.actors.map(a =>
                  el(
                    'tr',
                    {},
                    el('td', {}, el('span', { class: 'dot', style: `background:${color(a.actor)}` }), actorLabel(a.actor)),
                    el('td', {}, `${Math.round((a.commits / commits) * 100)}%`),
                    el('td', {}, compact(a.commits)),
                    el('td', {}, `+${compact(a.adds)} −${compact(a.dels)}`),
                    el('td', {}, String(a.prs)),
                  ),
                ),
              ),
            ),
          ),
        )
      : null,
    agg.mixed > 0 ? el('p', { class: 'dim' }, `${agg.mixed} PR${agg.mixed === 1 ? ' has' : 's have'} commits from more than one of the above.`) : null,
    el('p', { class: 'dim' }, "Attributed by each commit's author and Co-Authored-By lines, not by who typed the code. Lines are added and removed in commits, so a commit that rewrites an earlier one counts again."),
    agg.days.length > 0 ? commitsOverTime(agg, sinceMs, color) : null,
    agg.weeks.length > 0
      ? el(
          'div',
          {},
          el('h3', {}, 'PRs merged per week', el('span', { class: 'dim' }, ' · last 26 weeks')),
          raw(
            weeksSvg(
              agg.weeks.slice(-26).map(w => ({
                label: w.start.slice(5),
                parts: Object.entries(w.prs)
                  .sort(([x], [y]) => (x === YOU ? -1 : y === YOU ? 1 : 0))
                  .map(([actor, value]) => ({ label: actorLabel(actor), value, color: color(actor) })),
              })),
              760,
              170,
            ),
          ),
        )
      : null,
    repoRows.length > 0
      ? el(
          'div',
          {},
          el('h3', {}, 'By repo', el('span', { class: 'dim' }, ' · click a repo to look at it alone')),
          raw(
            barsSvg(
              repoRows.slice(0, 12).map(r => ({
                label: r.repo,
                parts: r.actors.map(a => ({ label: actorLabel(a.actor), value: a.commits, color: color(a.actor) })),
                note: `${r.prs} PR${r.prs === 1 ? '' : 's'}`,
              })),
              760,
            ),
          ),
          el(
            'table',
            {},
            el(
              'thead',
              {},
              el(
                'tr',
                {},
                th('Repo', 'repo', state.sort, setSort),
                th('PRs', 'prs', state.sort, setSort),
                th('Commits', 'commits', state.sort, setSort),
                th('Added', 'adds', state.sort, setSort),
                th('Removed', 'dels', state.sort, setSort),
                th('You', 'you', state.sort, setSort),
              ),
            ),
            el(
              'tbody',
              {},
              ...repoRows.map(r => {
                const c = commitsOf(r)
                const mine = r.actors.find(a => a.actor === YOU)?.commits ?? 0
                return el(
                  'tr',
                  { class: 'click', onclick: () => ((state.repo = r.repo), draw()) },
                  el('td', {}, r.repo),
                  el('td', {}, String(r.prs)),
                  el('td', {}, compact(c)),
                  el('td', {}, `+${compact(r.actors.reduce((n, a) => n + a.adds, 0))}`),
                  el('td', {}, `−${compact(r.actors.reduce((n, a) => n + a.dels, 0))}`),
                  el('td', {}, c ? `${Math.round((mine / c) * 100)}%` : '-'),
                )
              }),
            ),
          ),
        )
      : null,
    created.length > 0
      ? el('div', {}, el('h3', {}, 'Repos created'), el('p', {}, created.map(r => `${r.name} (${r.createdAt.slice(0, 10)})${r.isArchived ? ' archived' : ''}`).join(' · ')))
      : null,
  )
}

// ---- Page --------------------------------------------------------------------------------------------------

const root = document.getElementById('app')!

// A VisualAssault theme is chosen from the header and remembered; storage can be unavailable, so it is optional.
const THEME_KEY = 'shipwatch-theme'
const themeLabel = (id: string): string => id.replace(/-theme$/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
const storedTheme = (): string => {
  try {
    const t = localStorage.getItem(THEME_KEY) ?? ''
    return THEME_IDS.includes(t) ? t : ''
  } catch {
    return ''
  }
}
const applyTheme = (id: string): void => {
  document.body.className = id
  try {
    if (id) localStorage.setItem(THEME_KEY, id)
    else localStorage.removeItem(THEME_KEY)
  } catch {
    // Not remembered; still applied for this page.
  }
}
applyTheme(storedTheme())

function draw(): void {
  const owner = data.board.owner || data.stats.you || 'GitHub'
  root.replaceChildren(
    el(
      'header',
      { class: 'row wrap' },
      data.logo ? el('img', { class: 'logo', src: data.logo, alt: '' }) : null,
      el('h1', {}, `${owner} · Shipwatch`),
      el('span', { class: 'dim' }, `generated ${new Date(data.generatedAt).toLocaleString()}`),
      el('span', { class: 'grow' }),
      el(
        'select',
        { class: 'theme', title: 'Theme', 'aria-label': 'Theme', onchange: (e: Event) => applyTheme((e.target as HTMLSelectElement).value) },
        el('option', { value: '' }, 'Default theme'),
        ...THEME_IDS.map(id => el('option', { value: id, selected: id === document.body.className ? 'selected' : undefined }, themeLabel(id))),
      ),
      button('Dashboard', state.view === 'dashboard', () => ((state.view = 'dashboard'), draw())),
      button('Stats', state.view === 'stats', () => ((state.view = 'stats'), draw())),
    ),
    state.view === 'dashboard' ? dashboard() : stats(),
  )
}

/** Redraws after a keystroke in the filter box without losing the caret. */
function drawKeepFocus(selector: string): void {
  const at = document.querySelector<HTMLInputElement>(selector)?.selectionStart ?? null
  draw()
  const after = document.querySelector<HTMLInputElement>(selector)
  if (after) {
    after.focus()
    if (at !== null) after.setSelectionRange(at, at)
  }
}

draw()

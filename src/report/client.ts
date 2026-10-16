// The script inside the Shipwatch report page. It reads the data the page was generated with and draws the
// dashboard and the stats with filters, sorting and a drill-down per repo. All numbers and charts come from
// the core (aggregate, charts), the same code the Claude pane uses; this file is only the page around them.
//
// Bundled by scripts/build-report.mjs into src/core/reportClient.generated.ts. Do not import a host API.

import { barsSvg, chartColor, donutSvg, legendSvg, linesSvg, weeksSvg } from '../core/charts'
import type { ReportData } from '../core/report'
import { THEME_IDS } from '../core/themes.generated'
import { RANGES, YOU, actorLabel, aggregate, aisIn, bucketFor, commitSeries, compact, earliestKnown, humansIn, rangeLabel, rangeSince, reposCreatedSince } from '../core/stats'
import type { Level, PrView, RepoView, StatsMode } from '../core/types'
import { clockPanel } from './clockPanel'

const data = (window as unknown as { SHIPWATCH_DATA: ReportData }).SHIPWATCH_DATA

const LEVEL_ORDER: Record<Level, number> = { fail: 0, running: 1, ready: 2, pending: 3, recent: 4, draft: 5, idle: 6 }
const LEVEL_LABEL: Record<Level, string> = {
  fail: 'Failing',
  running: 'Building',
  ready: 'Ready to merge',
  pending: 'Awaiting release',
  recent: 'Recently merged',
  draft: 'Draft only',
  idle: 'Quiet',
}
const STEP_NAMES = ['PR', 'Build', 'Merged', 'Released']

type Sort = { key: string; dir: 1 | -1 }

type State = {
  view: 'dashboard' | 'stats'
  range: (typeof RANGES)[number]
  mode: StatsMode
  humans: StatsMode
  hidden: string[]
  repo: string | null
  q: string
  level: Level | 'all'
  /** Show draft PRs (and PRs titled "do not merge") and the repos that have only those; off unless asked for. */
  drafts: boolean
  sort: Sort
  dashSort: Sort
}

const state: State = {
  view: data.board.repos.length > 0 ? 'dashboard' : 'stats',
  range: 365,
  mode: 'combined',
  humans: 'combined',
  hidden: [],
  repo: null,
  q: '',
  level: 'all',
  drafts: storedDrafts(),
  sort: { key: 'commits', dir: -1 },
  dashSort: { key: 'level', dir: 1 },
}

// Whether to include drafts is remembered between visits; storage can be unavailable, so it is optional.
const DRAFTS_KEY = 'shipwatch-drafts'
function storedDrafts(): boolean {
  try {
    return localStorage.getItem(DRAFTS_KEY) === '1'
  } catch {
    return false
  }
}
function rememberDrafts(on: boolean): void {
  try {
    localStorage.setItem(DRAFTS_KEY, on ? '1' : '0')
  } catch {
    // Not remembered; still applied for this page.
  }
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

/** The width the wide charts are drawn at: the page's content box, so they line up with the tables and text. */
const chartWidth = (): number => Math.max(320, Math.round(root.clientWidth - 32))

/** A chart: markup from the core's chart functions, which escape everything they were given. */
const raw = (html: string): HTMLElement => {
  const box = el('div', { class: 'svg' })
  box.innerHTML = html
  return box
}

/** How long ago, as of now (not as of when the data was read, which may have been saved a while back). */
const ago = (iso: string): string => {
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return ''
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${Math.max(1, m)}m ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`
}

const button = (label: string, active: boolean, onclick: () => void): HTMLElement =>
  el('button', { class: active ? 'btn on' : 'btn', onclick }, label)

/** One of the two tabs under the header; the selected one is marked for screen readers as well as by its look. */
const tab = (label: string, selected: boolean, onclick: () => void): HTMLElement =>
  el('button', { class: selected ? 'tab on' : 'tab', role: 'tab', 'aria-selected': selected ? 'true' : 'false', onclick }, label)

const th = (label: string, key: string, sort: Sort, set: (key: string) => void): HTMLElement =>
  el('th', { class: 'sortable', onclick: () => set(key) }, label + (sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''))

const compare = (x: string | number, y: string | number): number => (x < y ? -1 : x > y ? 1 : 0)

/** Only the standalone app offers a way to act on a PR (its preload script adds this); a report opened in a browser has none. */
const bridge = (
  window as unknown as {
    shipwatch?: {
      mergePr: (repo: string, number: number) => Promise<{ ok: boolean; message: string }>
      fetchStatsNow?: () => Promise<{ ok: boolean; message: string }>
    }
  }
).shipwatch

/**
 * A Merge button for an open PR that could be merged: not a draft, no conflict, no failing check. The app asks
 * the user to confirm and re-reads the PR from GitHub, so this is only the way in, not the decision.
 */
const mergeControl = (repo: string, p: PrView): Child => {
  if (!bridge || p.parked || p.hasConflict || p.checks === 'failing') return null
  const waiting = p.checks === 'running'
  const note = el('span', { class: 'dim' })
  const btn = el('button', { class: 'btn', title: waiting ? 'Merges when its checks pass' : 'Merge this PR' }, waiting ? 'Merge when checks pass' : 'Merge')
  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', '')
    note.textContent = ' Working...'
    let said = 'Could not reach the app.'
    try {
      said = (await bridge.mergePr(repo, p.number)).message
    } catch {
      // Keep the message above.
    }
    btn.removeAttribute('disabled')
    note.textContent = ` ${said}`
  })
  return el('span', {}, ' ', btn, note)
}

// ---- Dashboard ---------------------------------------------------------------------------------------------

function dashboard(): HTMLElement {
  const needle = state.q.toLowerCase()
  // Drafts and "do not merge" PRs are left out unless asked for: repos with only those are hidden, and such PRs are
  // not listed against the others.
  const draftOnly = data.board.repos.filter(r => r.level === 'draft').length
  const inView = data.board.repos.filter(r => state.drafts || r.level !== 'draft')
  const openPrs = (r: RepoView): PrView[] => (state.drafts ? r.prs : r.prs.filter(p => !p.parked))
  const repos = inView.filter(r => (state.level === 'all' || r.level === state.level) && r.name.toLowerCase().includes(needle))
  const keyOf: Record<string, (r: RepoView) => string | number> = {
    level: r => LEVEL_ORDER[r.level],
    name: r => r.name.toLowerCase(),
    prs: r => openPrs(r).length,
    pushed: r => -Date.parse(r.pushedAt || '1970-01-01'),
  }
  const pick = keyOf[state.dashSort.key] ?? keyOf.level!
  repos.sort((a, b) => compare(pick(a), pick(b)) * state.dashSort.dir)

  const setSort = (key: string) => {
    state.dashSort = { key, dir: state.dashSort.key === key ? (-state.dashSort.dir as 1 | -1) : 1 }
    draw()
  }
  const counts = (Object.keys(LEVEL_ORDER) as Level[]).map(l => [l, inView.filter(r => r.level === l).length] as const)

  return el(
    'section',
    {},
    clockPanel(() => (state.drafts ? data.recentPrs : data.recentPrs?.filter(p => !p.parked))),
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
      button(`All ${inView.length}`, state.level === 'all', () => ((state.level = 'all'), draw())),
      ...counts.filter(([, n]) => n > 0).map(([l, n]) => button(`${LEVEL_LABEL[l]} ${n}`, state.level === l, () => ((state.level = l), draw()))),
      el('span', { class: 'grow' }),
      el(
        'label',
        { class: 'check', title: 'Draft PRs and PRs titled "do not merge" are left out of the list, the clock and each repo\'s status unless this is on.' },
        el('input', {
          type: 'checkbox',
          checked: state.drafts ? 'checked' : undefined,
          onchange: (e: Event) => {
            state.drafts = (e.target as HTMLInputElement).checked
            if (!state.drafts && state.level === 'draft') state.level = 'all'
            rememberDrafts(state.drafts)
            draw()
          },
        }),
        ` Include drafts${state.drafts || draftOnly === 0 ? '' : ` (${draftOnly} draft-only ${draftOnly === 1 ? 'repo' : 'repos'} hidden)`}`,
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
              ...(openPrs(r).length
                ? openPrs(r).map(p =>
                    el('div', {}, el('a', { href: p.url, target: '_blank', rel: 'noopener' }, `#${p.number}`), ` ${p.title}`, p.isDraft ? el('span', { class: 'dim' }, ' draft') : p.parked ? el('span', { class: 'dim' }, ' set aside') : null, mergeControl(r.name, p)),
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
    raw(linesSvg(labels, actors.map(a => ({ label: actorLabel(a), color: color(a), values: values[a] ?? [] })), chartWidth(), 210)),
  )
}

// ---- Stats still loading -----------------------------------------------------------------------------------
// The app shows the dashboard first and reads the long stats history afterwards, handing the page what it has
// as it arrives (see `shipwatchLive` at the end). Until then the Stats tab says what is going on.

type Status = NonNullable<ReportData['statsStatus']>

/**
 * "Fetch now" under a stopped stats load: the app reads the history right away, using the share of GitHub's
 * hourly allowance it normally keeps for other tools. Only the app can (a report opened in a browser has no way to).
 */
function fetchNowControl(): HTMLElement[] {
  if (!bridge?.fetchStatsNow) return []
  const ask = bridge.fetchStatsNow
  const note = el('span', { class: 'dim' })
  const btn = el('button', { class: 'btn', title: "Loads the rest now, using the part of GitHub's hourly allowance kept free for your other tools" }, 'Fetch now')
  btn.addEventListener('click', async () => {
    btn.setAttribute('disabled', '')
    note.textContent = ' Working...'
    let said = 'Could not reach the app.'
    try {
      said = (await ask()).message
    } catch {
      // Keep the message above.
    }
    btn.removeAttribute('disabled')
    note.textContent = ` ${said}`
  })
  return [el('div', { class: 'row' }, btn, note, el('span', { class: 'dim' }, 'Uses the allowance kept free for your other tools.'))]
}

/** Fills the notice for `st`: what is happening, a bar while it loads, and what is held so far. */
function fillBanner(box: HTMLElement, st: Status, kind: 'stats' | 'board' = 'stats'): void {
  box.className = st.state === 'error' ? 'banner bad' : 'banner'
  if (kind === 'board') {
    // The dashboard on screen is the one saved last time; this says so, and what is happening about it.
    const saved = `Showing what was saved ${new Date(data.generatedAt).toLocaleString()}.`
    if (st.state === 'error') {
      box.replaceChildren(
        el('strong', {}, 'Could not update from GitHub'),
        el('div', {}, st.text),
        el('div', { class: 'dim' }, `${saved} It will try again by itself.`),
      )
      return
    }
    const bar = el('div', { class: 'meter' }, el('div'))
    bar.setAttribute('data-indeterminate', '1')
    box.replaceChildren(el('strong', {}, 'Updating from GitHub...'), el('div', { class: 'dim' }, st.text || 'Starting...'), bar, el('div', { class: 'dim' }, saved))
    return
  }
  const held = data.stats.prs.reduce((min, p) => (p.mergedAt < min ? p.mergedAt : min), '9999')
  const heldNote = data.stats.prs.length > 0 ? `Showing what is saved so far (back to ${held.slice(0, 10)}).` : 'Nothing is saved yet.'
  if (st.state === 'error') {
    box.replaceChildren(
      el('strong', {}, 'Stats are incomplete'),
      el('div', {}, st.text),
      el('div', { class: 'dim' }, `${heldNote} What has loaded is kept; choose View, Refresh to carry on from there.`),
      ...fetchNowControl(),
    )
    return
  }
  const meter = el('div', { class: 'meter' }, el('div'))
  if (typeof st.fraction === 'number') (meter.firstElementChild as HTMLElement).style.width = `${Math.round(st.fraction * 100)}%`
  else meter.setAttribute('data-indeterminate', '1')
  box.replaceChildren(
    el('strong', {}, 'Loading your history from GitHub...'),
    el('div', { class: 'dim' }, st.text || 'Starting...'),
    meter,
    el('div', { class: 'dim' }, `${heldNote} Longer ranges fill in as it goes; it only reads what it does not already have.`),
    ...fetchNowControl(),
  )
}

/** The notice under the header while the dashboard shown is a saved one being updated, or its update failed. */
function boardBanner(): HTMLElement | null {
  const st = data.boardStatus
  if (!st) return null
  const box = el('div', { id: 'board-banner' })
  fillBanner(box, st, 'board')
  return box
}

// ---- GitHub allowance readout ------------------------------------------------------------------------------
// A small chip in the header: how many of GitHub's GraphQL points are left, so it is easy to see if something is
// using them up. The app reads it from the endpoint that costs nothing, every half minute.

/** The first reading of this hour's allowance seen by this page, to say how many points were used since. */
let apiBaseline: { resetAt: number; remaining: number } | undefined

function apiChipText(): { text: string; tone: string; title: string } | null {
  const g = data.api?.graphql
  if (!g) return null
  if (!apiBaseline || apiBaseline.resetAt !== g.resetAt || g.remaining > apiBaseline.remaining) apiBaseline = { resetAt: g.resetAt, remaining: g.remaining }
  const used = apiBaseline.remaining - g.remaining
  const share = g.limit > 0 ? g.remaining / g.limit : 1
  const reset = new Date(g.resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  const core = data.api?.core
  return {
    text: `GitHub API ${g.remaining.toLocaleString()} / ${g.limit.toLocaleString()}${used > 0 ? ` · −${used.toLocaleString()} since opened` : ''}`,
    tone: share < 0.1 ? 'critical' : share < 0.3 ? 'low' : 'ok',
    title:
      `GraphQL points left this hour: ${g.remaining.toLocaleString()} of ${g.limit.toLocaleString()}, resetting at ${reset}.` +
      (core ? ` REST: ${core.remaining.toLocaleString()} of ${core.limit.toLocaleString()}.` : '') +
      ' Read from GitHub every 30 seconds without using any points.',
  }
}

function apiChip(): HTMLElement | null {
  const c = apiChipText()
  if (!c) return null
  return el('span', { class: `chip-api ${c.tone}`, id: 'api-chip', title: c.title }, c.text)
}

function statsBanner(): HTMLElement | null {
  const st = data.statsStatus
  if (!st) return null
  const box = el('div', { id: 'stats-banner' })
  fillBanner(box, st)
  return box
}

function stats(): HTMLElement {
  const s = data.stats
  const ais = aisIn(s.prs)
  const people = humansIn(s.prs)
  const sinceMs = rangeSince(state.range, data.generatedAt, earliestKnown(s.repos, s.prs))
  const inScope = state.repo ? s.prs.filter(p => p.repo === state.repo) : s.prs
  const agg = aggregate(inScope, sinceMs, state.mode, state.hidden, state.humans)
  const created = reposCreatedSince(s.repos, sinceMs)
  const sum = (pick: (a: (typeof agg.actors)[number]) => number) => agg.actors.reduce((n, a) => n + pick(a), 0)
  const commits = sum(a => a.commits)
  const you = agg.actors.find(a => a.actor === YOU)?.commits ?? 0
  const color = (a: string) => chartColor(a, ais, people)

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
    statsBanner(),
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
    people.length > 0
      ? el(
          'div',
          { class: 'row wrap' },
          button(state.humans === 'combined' ? 'All other humans' : 'Each human', true, () => ((state.humans = state.humans === 'combined' ? 'separate' : 'combined'), draw())),
          ...people.map(h =>
            button(`${state.hidden.includes(h) ? '○' : '●'} ${actorLabel(h)}`, !state.hidden.includes(h), () => {
              state.hidden = state.hidden.includes(h) ? state.hidden.filter(x => x !== h) : [...state.hidden, h]
              draw()
            }),
          ),
        )
      : null,
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
            { class: 'fill' },
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
              chartWidth(),
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
              chartWidth(),
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
      apiChip(),
      el(
        'select',
        { class: 'theme', title: 'Theme', 'aria-label': 'Theme', onchange: (e: Event) => applyTheme((e.target as HTMLSelectElement).value) },
        el('option', { value: '' }, 'Default theme'),
        ...THEME_IDS.map(id => el('option', { value: id, selected: id === document.body.className ? 'selected' : undefined }, themeLabel(id))),
      ),
    ),
    // The two views are tabs: one row of their own, two equal columns across the full width.
    el(
      'nav',
      { class: 'tabs', role: 'tablist' },
      tab('Dashboard', state.view === 'dashboard', () => ((state.view = 'dashboard'), draw())),
      tab(data.statsStatus?.state === 'loading' ? 'Stats (loading...)' : 'Stats', state.view === 'stats', () => ((state.view = 'stats'), draw())),
    ),
    ...(data.boardStatus ? [boardBanner()!] : []),
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

// The charts are drawn at the page's width, so a resized window redraws the Stats tab to fit.
let drawnWidth = chartWidth()
let resizeTimer: ReturnType<typeof setTimeout> | undefined
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    const w = chartWidth()
    if (w === drawnWidth) return
    drawnWidth = w
    if (state.view === 'stats') draw()
  }, 150)
})

/**
 * What the host calls to fill the stats in after the page is up: `setStats` with the history so far (the page
 * keeps its tab, filters and range), `setStatus` with how loading is going (or nothing when it is done).
 * Progress updates only repaint the notice, so a long load does not keep redrawing the page under the reader.
 */
;(window as unknown as { shipwatchLive: unknown }).shipwatchLive = {
  setStats(stats: ReportData['stats']): void {
    data.stats = stats
    draw()
  },
  /** A freshly read dashboard replaces the saved one on screen; the tab, filters and sort stay as they are. */
  setBoard(board: ReportData['board'], generatedAt: number, recent: ReportData['recentPrs'] | null): void {
    data.board = board
    data.generatedAt = generatedAt
    if (recent) data.recentPrs = recent
    draw()
  },
  /** How updating the dashboard is going; null once the dashboard on screen is current. */
  setBoardStatus(status: ReportData['boardStatus'] | null): void {
    const before = data.boardStatus?.state
    data.boardStatus = status ?? undefined
    const box = document.getElementById('board-banner')
    if (status && box && before === status.state) fillBanner(box, status, 'board')
    else draw()
  },
  /** The last hour's PRs; the clock picks them up on its next tick. */
  setRecent(recent: NonNullable<ReportData['recentPrs']>): void {
    data.recentPrs = recent
  },
  /** What is left of GitHub's allowances; only the chip in the header is repainted. */
  setApi(api: NonNullable<ReportData['api']>): void {
    data.api = api
    const c = apiChipText()
    const chip = document.getElementById('api-chip')
    if (c && chip) {
      chip.className = `chip-api ${c.tone}`
      chip.title = c.title
      chip.textContent = c.text
    } else {
      draw()
    }
  },
  setStatus(status: ReportData['statsStatus'] | null): void {
    const before = data.statsStatus?.state
    data.statsStatus = status ?? undefined
    const box = document.getElementById('stats-banner')
    if (status && box && before === status.state) fillBanner(box, status)
    else draw()
  },
}

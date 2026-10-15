import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { ago, failedOnMain, fixPrompt, snapshot, transitions } from '../src/core/analyze'
import type { Seen } from '../src/core/analyze'
import { buildBoard } from '../src/core/boardService'
import type { InfraVerdicts } from '../src/core/boardService'
import { connect, resolveOwner } from '../src/core/github'
import { headlineLink, safeHref, stepLinks } from '../src/core/links'
import type { StepLinks } from '../src/core/links'
import type { Access, IO, Store } from '../src/core/ports'
import {
  ALL_AI,
  AUTOMATION,
  MIXED,
  OTHERS,
  RANGES,
  YOU,
  aggregate,
  aisIn,
  barCells,
  compact,
  reposCreatedSince,
  sinceFor,
} from '../src/core/stats'
import { loadStatsCache, refreshStats, statsAreFresh } from '../src/core/statsService'
import type { Board, Checks, Level, PrView, RepoView, StatsBoard, StatsMode, StepState } from '../src/core/types'
import type { ViewName } from '../types'

const PANE = 'shipwatch'
const STEP_LABELS = ['PR', 'Build', 'Merged', 'Released'] as const
const ACTIVE_POLL_MS = 20_000
const ERROR_POLL_MS = 60_000
const MAX_PRS_SHOWN = 3

const INITIAL: Board = { owner: '', repos: [], updatedAt: 0, isLoading: false, error: null, source: null }
const board = atom({ plugin: 'shipwatch', key: 'board' } as const, INITIAL)
const showStale = atom({ plugin: 'shipwatch', key: 'showStale' } as const, false)
const view = atom({ plugin: 'shipwatch', key: 'view' } as const, 'dashboard' as ViewName)
const INITIAL_STATS: StatsBoard = {
  range: 30,
  mode: 'combined',
  hidden: [],
  prs: [],
  repos: [],
  coveredFrom: '',
  coveredThrough: '',
  you: '',
  isLoading: false,
  progress: '',
  error: null,
  updatedAt: 0,
}
const stats = atom({ plugin: 'shipwatch', key: 'stats' } as const, INITIAL_STATS)

const STEP_STYLE: Record<StepState, { icon: string; color?: string }> = {
  done: { icon: '●', color: 'green' },
  running: { icon: '◐', color: 'yellow' },
  failed: { icon: '✗', color: 'red' },
  todo: { icon: '○' },
}

const CHECK_STYLE: Record<Checks, { icon: string; color?: string }> = {
  passing: { icon: '✓', color: 'green' },
  running: { icon: '◐', color: 'yellow' },
  failing: { icon: '✗', color: 'red' },
  none: { icon: '·' },
}

const LEVEL_COLOR: Record<Level, string | undefined> = {
  fail: 'red',
  running: 'yellow',
  ready: 'cyan',
  pending: 'yellow',
  draft: undefined,
  idle: undefined,
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

type Config = {
  owner: string
  token: string
  includeForks: boolean
  count: number
  idleMs: number
  staleMs: number
  autoFix: boolean
  autoFixLimit: number
  aiNames: string[]
  ignore: Set<string>
}

// Module variables start over on a hot reload; the board itself lives in $.state.
let cfg: Config
let seen: Seen = {}
let access: Access | undefined
let resolvedOwner = ''
let isPolling = false
const infraVerdicts: InfraVerdicts = new Map()
/** `repo:commit` pairs already sent for fixing, and how many prompts this load has sent. */
const prompted = new Set<string>()
let promptCount = 0
let isLoadingStats = false
let timer: { cancel: () => void } | undefined

async function refresh($: any): Promise<number> {
  if (isPolling) return cfg.idleMs
  isPolling = true
  await update($, board, b => ({ ...b, isLoading: true }))
  let delay = cfg.idleMs
  const io: IO = {
    run: (argv, init) => $.process.run(argv, init),
    fetch: (url, init) => $.http.fetch(url, init),
  }
  try {
    access ??= await connect(io, cfg.token)
    resolvedOwner ||= await resolveOwner(io, access, cfg.owner)
    const now: number = await $.clock.now()
    const repos = await buildBoard(
      io,
      access,
      { owner: resolvedOwner, count: cfg.count, includeForks: cfg.includeForks, ignore: cfg.ignore, staleMs: cfg.staleMs },
      now,
      infraVerdicts,
    )

    for (const line of transitions(seen, repos)) $.ui.toast(line)
    if (cfg.autoFix) {
      for (const r of failedOnMain(seen, repos)) {
        const key = `${r.name}:${r.headOid}`
        if (prompted.has(key) || promptCount >= cfg.autoFixLimit) continue
        prompted.add(key)
        const text = fixPrompt(resolvedOwner, r)
        if (!text) {
          $.ui.toast(`Shipwatch: ${r.name} main build failed (unusual name, not auto-fixing)`)
          continue
        }
        promptCount += 1
        $.ui.toast(`Shipwatch: asking Claude to look into ${r.name} main (${promptCount}/${cfg.autoFixLimit})`)
        // Queued: it starts its own turn once this session is idle.
        void $.prompt.submit({ text })
      }
    }
    seen = snapshot(repos)
    $.ui.status(statusLine(repos))

    const source = access.source
    await update($, board, () => ({ owner: resolvedOwner, repos, updatedAt: now, isLoading: false, error: null, source }))
    if (repos.some(r => r.level === 'running')) delay = ACTIVE_POLL_MS
  } catch (err) {
    access = undefined
    resolvedOwner = ''
    const message = err instanceof Error ? err.message : String(err)
    await update($, board, b => ({ ...b, isLoading: false, error: message }))
    delay = ERROR_POLL_MS
  } finally {
    isPolling = false
  }
  return delay
}

/**
 * Brings the Stats view up to date (see `refreshStats` in the core, which does the work and keeps the
 * history in the store). This only wires it to the pane: the engine's process, HTTP and store calls in,
 * progress and results out to `$.state`.
 */
async function loadStats($: any, force = false): Promise<void> {
  if (isLoadingStats) return
  isLoadingStats = true
  const io: IO = {
    run: (argv, init) => $.process.run(argv, init),
    fetch: (url, init) => $.http.fetch(url, init),
  }
  const store: Store = {
    get: key => $.store.get(key),
    set: (key, value) => $.store.set(key, value),
  }
  try {
    access ??= await connect(io, cfg.token)
    resolvedOwner ||= await resolveOwner(io, access, cfg.owner)
    const owner = resolvedOwner
    let s = await read($, stats)
    if (s.prs.length === 0 && !s.coveredFrom) {
      const saved = await loadStatsCache(store, owner, cfg.aiNames)
      if (saved) {
        await update($, stats, x => ({ ...x, ...saved }))
        s = await read($, stats)
      }
    }
    const now: number = await $.clock.now()
    if (!force && statsAreFresh(s, now)) return

    await update($, stats, x => ({ ...x, isLoading: true, error: null, progress: 'Starting...' }))
    const done = await refreshStats(
      {
        io,
        access,
        store,
        owner,
        aiNames: cfg.aiNames,
        now,
        // Written without waiting, so a late one must not land after the final state: only while loading.
        onProgress: text => void update($, stats, x => (x.isLoading ? { ...x, progress: text } : x)),
        onPartial: (prs, you) => void update($, stats, x => (x.isLoading ? { ...x, prs, you } : x)),
      },
      s,
    )
    await update($, stats, x => ({ ...x, ...done, isLoading: false, progress: '', error: null, updatedAt: now }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await update($, stats, x => ({ ...x, isLoading: false, progress: '', error: message }))
  } finally {
    isLoadingStats = false
  }
}

function loop($: any, wait: number): void {
  timer?.cancel()
  timer = $.clock.after(wait, async () => loop($, await refresh($)))
}

const AI_COLORS = ['magenta', 'blue', 'yellow', 'cyan', 'red']

/** The colour an actor is drawn in: You green, each AI its own, everyone else dim. */
const colorOf = (actor: string, ais: readonly string[]): string | undefined => {
  if (actor === YOU) return 'green'
  if (actor === ALL_AI) return 'magenta'
  if (actor === OTHERS || actor === AUTOMATION || actor === MIXED) return undefined
  const i = ais.indexOf(actor)
  return AI_COLORS[(i < 0 ? 0 : i) % AI_COLORS.length]
}

export const register: Register = (on, options) => {
  cfg = {
    owner: str(options.owner),
    token: str(options.githubToken),
    includeForks: options.includeForks === true,
    count: Math.min(100, Math.max(1, Math.round(num(options.maxRepos, 40)))),
    idleMs: Math.max(15, num(options.pollSeconds, 60)) * 1000,
    staleMs: Math.max(1, num(options.staleDays, 14)) * 86_400_000,
    autoFix: options.autoFix === true,
    autoFixLimit: Math.max(0, Math.round(num(options.autoFixLimit, 5))),
    aiNames: str(options.aiNames)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean),
    ignore: new Set(
      str(options.ignoreRepos)
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(Boolean),
    ),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'shipwatch',
      description: 'Open the Shipwatch dashboard: builds, open PRs and release progress for every repo',
    })
    loop($, 1)

    return next(e)
  })

  on('command.run', { command: 'shipwatch' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Shipwatch' })
    loop($, 1)

    return { text: 'Shipwatch opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Link } = $.ui.resolve(e)
    const b = await read($, board)
    const now: number = await $.clock.now()
    const columns = (e.props as { bodyColumns?: number }).bodyColumns ?? e.viewport?.columns ?? 80

    const isStaleShown = await read($, showStale)
    const active = b.repos.filter(r => r.level !== 'idle' && !r.isStale)
    const stale = b.repos.filter(r => r.level !== 'idle' && r.isStale)
    const idle = b.repos.filter(r => r.level === 'idle')
    const nameWidth = Math.min(22, Math.max(8, ...active.map(r => r.name.length))) + 2
    const refreshLabel = b.isLoading ? 'Refreshing…' : 'Refresh'

    const since = (iso: string): string => {
      const age = ago(iso, now)
      return age === 'now' || age === '' ? 'now' : `${age} ago`
    }

    // Text that links when its URL passes the engine's href rules, plain text otherwise.
    const linked = (href: string | undefined, text: string) => (href ? <Link href={href}>{text}</Link> : text)

    const stepper = (steps: RepoView['steps'], links: StepLinks) => (
      <Box>
        {steps.map((s, i) => {
          const style = STEP_STYLE[s]
          return (
            <Box>
              <Text color={style.color} dimColor={s === 'todo'} bold={s === 'running'}>
                {style.icon} {linked(links[i], STEP_LABELS[i] ?? '')}
              </Text>
              {i < steps.length - 1 && <Text dimColor> ─ </Text>}
            </Box>
          )
        })}
      </Box>
    )

    const prLine = (pr: PrView) => {
      const style = CHECK_STYLE[pr.checks]
      const href = safeHref(pr.url)
      // A draft's whole line is quiet: its checks and conflicts are shown, but nothing is red.
      const quiet = pr.isDraft
      // Spacing comes from the Box's gap, not trailing spaces: the desktop pane trims a Text's trailing space.
      return (
        <Box paddingLeft={2} columnGap={1}>
          <Text color={quiet ? undefined : style.color} dimColor={quiet || pr.checks === 'none'}>{style.icon}</Text>
          <Text dimColor>{linked(href, `#${pr.number}`)}</Text>
          <Text wrap="truncate-end" dimColor={quiet}>{linked(href, pr.title)}</Text>
          {pr.isDraft && <Text dimColor>draft</Text>}
          {pr.hasConflict && <Text color={quiet ? undefined : 'red'} dimColor={quiet}>conflicts</Text>}
        </Box>
      )
    }

    const repoRow = (r: RepoView) => {
      const shown = r.name.slice(0, nameWidth - 2)
      return (
        <Box flexDirection="column" marginBottom={1}>
          <Box flexWrap="wrap" columnGap={2}>
            <Text bold>
              {linked(safeHref(r.url), shown)}
              {' '.repeat(nameWidth - 2 - shown.length)}
            </Text>
            {stepper(r.steps, stepLinks(r))}
          </Box>
          <Box paddingLeft={2}>
            <Text color={r.isInfra ? 'yellow' : LEVEL_COLOR[r.level]} dimColor={r.level === 'draft'}>
              {linked(headlineLink(r), r.headline)}
            </Text>
            <Text dimColor> · pushed {since(r.pushedAt)}</Text>
          </Box>
          {r.activity.map(run => (
            <Box paddingLeft={2}>
              <Text color="yellow">▸ </Text>
              <Text dimColor>{linked(safeHref(run.url), run.text)}</Text>
            </Box>
          ))}
          {r.prs.slice(0, MAX_PRS_SHOWN).map(prLine)}
          {r.prs.length > MAX_PRS_SHOWN && (
            <Box paddingLeft={2}>
              <Text dimColor>+{r.prs.length - MAX_PRS_SHOWN} more open PRs</Text>
            </Box>
          )}
        </Box>
      )
    }

    const s = await read($, stats)
    const currentView = await read($, view)

    const viewTabs = (
      <Box columnGap={1}>
        <Button
          key="view-dashboard"
          hotkey="d"
          label="Dashboard"
          variant={currentView === 'dashboard' ? 'primary' : 'secondary'}
          onPress={() => void update($, view, () => 'dashboard' as ViewName)}
        />
        <Button
          key="view-stats"
          hotkey="t"
          label="Stats"
          variant={currentView === 'stats' ? 'primary' : 'secondary'}
          onPress={() => {
            void update($, view, () => 'stats' as ViewName)
            void loadStats($)
          }}
        />
      </Box>
    )

    /** The Stats view: who the shipped work is attributed to, by PR, commit and line, over a chosen range. */
    const statsTree = () => {
      const sinceMs = sinceFor(s.range, now)
      const agg = aggregate(s.prs, sinceMs, s.mode, s.hidden)
      const ais = aisIn(s.prs)
      const created = reposCreatedSince(s.repos, sinceMs)
      const sum = (pick: (a: (typeof agg.actors)[number]) => number) => agg.actors.reduce((n, a) => n + pick(a), 0)
      const totalCommits = sum(a => a.commits)
      const barWidth = Math.max(10, Math.min(36, columns - 50))
      const nameWidth = Math.max(6, ...agg.actors.map(a => a.actor.length)) + 1
      const owner = b.owner || s.you

      const stacked = (parts: Array<{ actor: string; value: number }>, width: number) => {
        const cells = barCells(
          parts.map(p => p.value),
          width,
        )
        return (
          <Box>
            {parts.map((p, i) => (
              <Text color={colorOf(p.actor, ais)} dimColor={colorOf(p.actor, ais) === undefined}>
                {'█'.repeat(cells[i]!)}
              </Text>
            ))}
          </Box>
        )
      }

      return (
        <Box flexDirection="column">
          <Box columnGap={2} marginBottom={1} flexWrap="wrap">
            <Text bold>{owner || 'GitHub'}</Text>
            {viewTabs}
            <Button
              key="stats-refresh"
              hotkey="r"
              label={s.isLoading ? 'Loading...' : 'Refresh'}
              onPress={() => void loadStats($, true)}
            />
          </Box>
          <Box columnGap={1} marginBottom={1} flexWrap="wrap">
            {RANGES.map((d, i) => (
              <Button
                key={`range-${d}`}
                hotkey={String(i + 1)}
                label={d === 365 ? 'Last year' : `${d} days`}
                variant={s.range === d ? 'primary' : 'secondary'}
                onPress={() => {
                  void update($, stats, x => ({ ...x, range: d }))
                  void loadStats($)
                }}
              />
            ))}
          </Box>
          <Box columnGap={1} marginBottom={1} flexWrap="wrap">
            <Button
              key="stats-mode"
              hotkey="m"
              label={s.mode === 'combined' ? 'You vs all AI' : 'You vs each AI'}
              onPress={() =>
                void update($, stats, x => ({ ...x, mode: (x.mode === 'combined' ? 'separate' : 'combined') as StatsMode }))
              }
            />
            {ais.map(ai => (
              <Button
                key={`ai-${ai}`}
                label={`${s.hidden.includes(ai) ? '○' : '●'} ${ai}`}
                onPress={() =>
                  void update($, stats, x => ({ ...x, hidden: x.hidden.includes(ai) ? x.hidden.filter(h => h !== ai) : [...x.hidden, ai] }))
                }
              />
            ))}
          </Box>
          {s.isLoading && (
            <Box marginBottom={1}>
              <Text color="yellow" wrap="wrap">{s.progress || 'Loading...'}</Text>
            </Box>
          )}
          {s.error && (
            <Box marginBottom={1}>
              <Text color="red" wrap="wrap">{s.error}</Text>
            </Box>
          )}
          {!s.isLoading && s.prs.length === 0 && !s.error && <Text dimColor>Nothing loaded yet.</Text>}

          <Box columnGap={3} marginBottom={1} flexWrap="wrap">
            <Text>
              <Text bold>{agg.prs}</Text> <Text dimColor>PRs merged</Text>
            </Text>
            <Text>
              <Text bold>{compact(totalCommits)}</Text> <Text dimColor>commits</Text>
            </Text>
            <Text>
              <Text color="green">+{compact(sum(a => a.adds))}</Text> <Text color="red">−{compact(sum(a => a.dels))}</Text>{' '}
              <Text dimColor>lines changed</Text>
            </Text>
            <Text>
              <Text bold>{created.length}</Text> <Text dimColor>repos created</Text>
            </Text>
          </Box>

          <Text bold>Who wrote it</Text>
          {agg.actors.map(a => {
            const share = totalCommits ? Math.round((a.commits / totalCommits) * 100) : 0
            const mine = barCells([a.commits, Math.max(0, totalCommits - a.commits)], barWidth)[0] ?? 0
            return (
              <Box columnGap={1}>
                <Text color={colorOf(a.actor, ais)} bold>
                  {a.actor.padEnd(nameWidth)}
                </Text>
                <Text color={colorOf(a.actor, ais)}>{'█'.repeat(mine)}</Text>
                <Text dimColor>{'░'.repeat(barWidth - mine)}</Text>
                <Text>{String(share).padStart(3)}%</Text>
                <Text dimColor>
                  {compact(a.commits)} commits · +{compact(a.adds)} −{compact(a.dels)} · {a.prs} PR{a.prs === 1 ? '' : 's'}
                </Text>
              </Box>
            )
          })}
          {agg.mixed > 0 && (
            <Text dimColor>
              {agg.mixed} PR{agg.mixed === 1 ? ' has' : 's have'} commits from more than one of the above.
            </Text>
          )}
          <Text dimColor wrap="wrap">
            Attributed by each commit's author and Co-Authored-By lines, not by who typed the code. Lines are added and removed in
            commits, so a commit that rewrites an earlier one counts again.
          </Text>

          {agg.repos.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>By repo</Text>
              {agg.repos.slice(0, 10).map(r => (
                <Box columnGap={1}>
                  <Text>{r.repo.slice(0, 22).padEnd(22)}</Text>
                  {stacked(
                    r.actors.map(a => ({ actor: a.actor, value: a.commits })),
                    Math.max(8, Math.min(30, barWidth)),
                  )}
                  <Text dimColor>{r.prs} PR{r.prs === 1 ? '' : 's'}</Text>
                </Box>
              ))}
              {agg.repos.length > 10 && <Text dimColor>+{agg.repos.length - 10} more repos</Text>}
            </Box>
          )}

          {agg.weeks.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>By week (PRs merged)</Text>
              {agg.weeks.slice(-12).map(w => {
                const entries = Object.entries(w.prs).sort(([x], [y]) => (x === YOU ? -1 : y === YOU ? 1 : 0))
                const peak = Math.max(...agg.weeks.slice(-12).map(k => Object.values(k.prs).reduce((a, c) => a + c, 0)))
                const total = entries.reduce((n, [, c]) => n + c, 0)
                const width = Math.max(1, Math.round((total / peak) * Math.max(8, Math.min(30, barWidth))))
                return (
                  <Box columnGap={1}>
                    <Text dimColor>{w.start.slice(5)}</Text>
                    {stacked(
                      entries.map(([actor, value]) => ({ actor, value })),
                      width,
                    )}
                    <Text dimColor>{total}</Text>
                  </Box>
                )
              })}
            </Box>
          )}

          {created.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>Repos created</Text>
              <Text dimColor wrap="wrap">
                {created
                  .slice(0, 20)
                  .map(r => `${r.name} (${r.createdAt.slice(0, 10)})${r.isArchived ? ' archived' : ''}`)
                  .join(' · ')}
                {created.length > 20 ? ` · +${created.length - 20} more` : ''}
              </Text>
            </Box>
          )}
          {s.updatedAt > 0 && (
            <Box marginTop={1}>
              <Text dimColor>updated {since(new Date(s.updatedAt).toISOString())}</Text>
            </Box>
          )}
        </Box>
      )
    }
    if (currentView === 'stats') return statsTree()

    return (
      <Box flexDirection="column">
        <Box columnGap={2} marginBottom={1}>
          <Text bold>{b.owner || 'GitHub'}</Text>
          {viewTabs}
          <Text dimColor>
            {b.updatedAt ? `updated ${since(new Date(b.updatedAt).toISOString())}` : 'loading…'}
            {b.source ? ` · via ${b.source}` : ''}
            {cfg.autoFix ? ' · auto-fix on' : ''}
          </Text>
          <Button key="refresh" hotkey="r" label={refreshLabel} onPress={() => void refresh($).then(d => loop($, d))} />
        </Box>
        {b.error && (
          <Box marginBottom={1}>
            <Text color="red" wrap="wrap">{b.error}</Text>
          </Box>
        )}
        {b.repos.length === 0 && !b.error && <Text dimColor>Fetching repos…</Text>}
        {active.length === 0 && b.repos.length > 0 && <Text color="green">Nothing in flight. All repos are quiet.</Text>}
        {active.map(repoRow)}
        {stale.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Box columnGap={2}>
              <Text dimColor>Stale ({stale.length}): nothing moved for a while</Text>
              <Button
                key="stale"
                hotkey="s"
                label={isStaleShown ? 'Hide' : 'Show'}
                onPress={() => void update($, showStale, shown => !shown)}
              />
            </Box>
            {isStaleShown ? (
              <Box flexDirection="column" marginTop={1}>
                {stale.map(repoRow)}
              </Box>
            ) : (
              <Text dimColor wrap="wrap">
                {stale.map(r => `${r.name} ${ago(r.pushedAt, now)}`).join(' · ')}
              </Text>
            )}
          </Box>
        )}
        {idle.length > 0 && (
          <Box flexDirection="column" width={Math.max(20, columns - 2)}>
            <Text dimColor wrap="wrap">
              Idle ({idle.length}): {idle.map(r => r.name).join(' · ')}
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}

const statusLine = (all: readonly RepoView[]): string | undefined => {
  const repos = all.filter(r => !r.isStale)
  const building = repos.filter(r => r.level === 'running').length
  const failing = repos.filter(r => r.level === 'fail' && !r.isInfra).length
  const outage = repos.filter(r => r.isInfra).length
  const prs = repos.reduce((n, r) => n + r.prs.length, 0)
  const parts: string[] = []
  if (building) parts.push(`◐ ${building} building`)
  if (failing) parts.push(`✗ ${failing} failing`)
  if (outage) parts.push(`⚠ ${outage} CI outage`)
  if (prs) parts.push(`${prs} open PR${prs === 1 ? '' : 's'}`)
  return parts.length ? parts.join(' · ') : undefined
}

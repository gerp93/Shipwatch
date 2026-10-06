import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Board, Checks, Level, PrView, RepoView, StepState } from '../types'
import { analyze, ago, byUrgency, failedOnMain, fixPrompt, markInfra, snapshot, transitions } from './analyze'
import type { Seen } from './analyze'
import { connect, fetchActivity, fetchInfraFailure, fetchRepos, resolveOwner } from './github'
import type { Access, IO } from './github'
import { headlineLink, safeHref, stepLinks } from './links'
import type { StepLinks } from './links'

const PANE = 'shipwatch'
const STEP_LABELS = ['PR', 'Build', 'Merged', 'Released'] as const
/** A missing release this soon after a merge reads as "awaiting", later as "not every commit ships". */
const RECENT_MS = 6 * 60 * 60 * 1000
const ACTIVE_POLL_MS = 20_000
const ERROR_POLL_MS = 60_000
/** How long a runner-outage verdict for a commit is trusted: a re-run can change it. */
const INFRA_TTL_MS = 5 * 60_000
const MAX_PRS_SHOWN = 3
const MAX_ACTIVITY_LOOKUPS = 8

const INITIAL: Board = { owner: '', repos: [], updatedAt: 0, isLoading: false, error: null, source: null }
const board = atom({ plugin: 'shipwatch', key: 'board' } as const, INITIAL)
const showStale = atom({ plugin: 'shipwatch', key: 'showStale' } as const, false)

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
  ignore: Set<string>
}

// Module variables start over on a hot reload; the board itself lives in $.state.
let cfg: Config
let seen: Seen = {}
let access: Access | undefined
let resolvedOwner = ''
let isPolling = false
const infraVerdicts = new Map<string, { isInfra: boolean; at: number }>()
/** `repo:commit` pairs already sent for fixing, and how many prompts this load has sent. */
const prompted = new Set<string>()
let promptCount = 0
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
    const raw = await fetchRepos(io, access, resolvedOwner, cfg.count, cfg.includeForks)
    const now: number = await $.clock.now()
    const repos = raw
      .filter(r => !r.isArchived && !cfg.ignore.has(r.name.toLowerCase()))
      .map(r => analyze(r, now, RECENT_MS, cfg.staleMs))
      .sort(byUrgency)

    for (let i = 0; i < repos.length; i++) {
      const r = repos[i]!
      if (r.level !== 'fail' || r.headline !== 'main build failing' || r.isStale) continue
      const key = `${r.name}:${r.headOid}`
      let verdict = infraVerdicts.get(key)
      if (!verdict || now - verdict.at > INFRA_TTL_MS) {
        let isInfra = false
        try {
          isInfra = await fetchInfraFailure(io, access, resolvedOwner, r.name, r.headOid)
        } catch {
          // Can't tell: treat it as the code's failure rather than hide it.
        }
        verdict = { isInfra, at: now }
        infraVerdicts.set(key, verdict)
      }
      repos[i] = markInfra(r, verdict.isInfra)
    }

    for (const r of repos.filter(r => r.level === 'running').slice(0, MAX_ACTIVITY_LOOKUPS)) {
      try {
        r.activity = await fetchActivity(io, access, resolvedOwner, r.name)
      } catch {
        // The headline already says it is building; run names are a bonus.
      }
    }

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

function loop($: any, wait: number): void {
  timer?.cancel()
  timer = $.clock.after(wait, async () => loop($, await refresh($)))
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
                {style.icon} {linked(links[i], STEP_LABELS[i])}
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
      return (
        <Box paddingLeft={2}>
          <Text color={style.color} dimColor={pr.checks === 'none'}>{style.icon} </Text>
          <Text dimColor>{linked(href, `#${pr.number}`)} </Text>
          <Text wrap="truncate-end">{linked(href, pr.title)}</Text>
          {pr.isDraft && <Text dimColor> draft</Text>}
          {pr.hasConflict && <Text color="red"> conflicts</Text>}
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
            <Text color={r.isInfra ? 'yellow' : LEVEL_COLOR[r.level]}>{linked(headlineLink(r), r.headline)}</Text>
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

    return (
      <Box flexDirection="column">
        <Box columnGap={2} marginBottom={1}>
          <Text bold>{b.owner || 'GitHub'}</Text>
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

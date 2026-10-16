import { AUTOMATION, isAi } from './stats'
import type { PrSummary, RepoCreated, RepoEffort } from './types'

// A build profile: what went into one repo and what it came to, so apps can be set side by side. What went in is
// time (calendar days, days with work) and, where the host can read Claude Code's history, session time and
// tokens (see effort.ts). What it came to is merged PRs, commits, lines and releases. Nothing here fetches.

const DAY_MS = 86_400_000

export type BuildProfile = {
  repo: string
  /** When the repo was created, ISO; empty when the repo list does not hold it. */
  startedAt: string
  /** The first and last PR merged, ISO; empty when none has been. */
  firstMergeAt: string
  lastMergeAt: string
  /** Calendar days (UTC) from the repo's creation (else its first merge) to its last merge, counting both ends; 0 with no merged PR. */
  calendarDays: number
  /** Days (UTC) on which a PR merged. */
  activeDays: number
  prs: number
  /** Commits by you and by AIs and other people; automation's are left out. */
  commits: number
  aiCommits: number
  /** Share of those commits an AI is named on, 0 to 1; 0 with no commits. */
  aiShare: number
  adds: number
  dels: number
  /** Lines added less lines removed: roughly what is in the repo now (a rewrite counts again, so it is an estimate). */
  netLines: number
  /** How many releases it has published; undefined when the dashboard does not hold the repo. */
  releases?: number
  /** From Claude Code's history on this computer; absent when the host cannot read it or the repo has none. */
  effort?: RepoEffort
  /** Net lines per hour of session time; absent without session time. */
  linesPerHour?: number
}

const dayOf = (iso: string): string => iso.slice(0, 10)

/**
 * One profile per repo that has merged PRs or session time, newest work first. `effort` and `releases` are keyed
 * by repo name and may be missing or partial.
 */
export const buildProfiles = (
  prs: readonly PrSummary[],
  repos: readonly RepoCreated[],
  effort: Readonly<Record<string, RepoEffort>> = {},
  releases: Readonly<Record<string, number>> = {},
): BuildProfile[] => {
  type Acc = { first: string; last: string; days: Set<string>; prs: number; commits: number; ai: number; adds: number; dels: number }
  const by = new Map<string, Acc>()
  for (const pr of prs) {
    const a = by.get(pr.repo) ?? { first: pr.mergedAt, last: pr.mergedAt, days: new Set<string>(), prs: 0, commits: 0, ai: 0, adds: 0, dels: 0 }
    by.set(pr.repo, a)
    if (pr.mergedAt < a.first) a.first = pr.mergedAt
    if (pr.mergedAt > a.last) a.last = pr.mergedAt
    a.days.add(dayOf(pr.mergedAt))
    a.prs++
    for (const [actor, [c, add, del]] of Object.entries(pr.by)) {
      a.adds += add
      a.dels += del
      if (actor === AUTOMATION) continue
      a.commits += c
      if (isAi(actor)) a.ai += c
    }
  }
  const created = new Map(repos.map(r => [r.name, r.createdAt]))
  const names = new Set([...by.keys(), ...Object.keys(effort)])
  const out: BuildProfile[] = []
  for (const repo of names) {
    const a = by.get(repo)
    const e = effort[repo]
    const startedAt = created.get(repo) ?? ''
    const begin = startedAt && a && startedAt < a.first ? startedAt : (a?.first ?? '')
    const calendarDays = a && begin ? Math.round((Date.parse(dayOf(a.last)) - Date.parse(dayOf(begin))) / DAY_MS) + 1 : 0
    const netLines = a ? a.adds - a.dels : 0
    const hours = e ? e.activeMs / 3_600_000 : 0
    out.push({
      repo,
      startedAt,
      firstMergeAt: a?.first ?? '',
      lastMergeAt: a?.last ?? '',
      calendarDays,
      activeDays: a?.days.size ?? 0,
      prs: a?.prs ?? 0,
      commits: a?.commits ?? 0,
      aiCommits: a?.ai ?? 0,
      aiShare: a && a.commits > 0 ? a.ai / a.commits : 0,
      adds: a?.adds ?? 0,
      dels: a?.dels ?? 0,
      netLines,
      releases: releases[repo],
      effort: e,
      linesPerHour: e && hours >= 0.05 && netLines > 0 ? netLines / hours : undefined,
    })
  }
  return out.sort((x, y) => (y.lastMergeAt || '').localeCompare(x.lastMergeAt || '') || x.repo.localeCompare(y.repo))
}

/** `3h 20m`, `45m`, `2d 4h` for a span of session time; `0m` for none. */
export const spanLabel = (ms: number): string => {
  const mins = Math.round(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${String(mins % 60).padStart(2, '0')}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** `1.2M`, `340k`, `812` for a token count. */
export const tokenLabel = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

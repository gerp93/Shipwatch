# Shipwatch core

Everything that decides what Shipwatch shows, written once. The Claude pane uses it today; a web
report or an app would use the same code. If you are about to write logic in `hooks/register.tsx`,
it probably belongs here instead.

## The rule

**The core knows nothing about its host.** No Claude engine (`$`), no Node, no DOM. It is checked
against the bare language (`tsconfig.json` here has no `types` and no DOM lib), so a host API
slipping in fails `npx -p typescript tsc --noEmit -p src/core/tsconfig.json`, locally and in CI.

What it needs from a host comes in through the small interfaces in `ports.ts`:

| Port | Is | The Claude pane supplies it from |
|---|---|---|
| `IO` | run `gh`, or make an HTTP call | `$.process.run`, `$.http.fetch` |
| `Store` | keep data between sessions | `$.store.get`, `$.store.set` |
| `now` (a number passed in) | the current time | `$.clock.now()` |

Anything that has to be shown, toasted, or acted on is the host's business: the core returns data.

## What is here

| File | Does |
|---|---|
| `types.ts` | The shapes: `RepoView`, `Board`, `PrSummary`, `StatsBoard`... Written once. |
| `ports.ts` | `IO`, `Access`, `Store`: what a host provides. |
| `analyze.ts` | Turns GitHub's raw repo data into where each repo is (stepper, headline, level), and decides what changed since the last look (toasts, failed builds, the auto-fix prompt). |
| `github.ts` | The dashboard's GitHub queries; connects through `gh` or a token. |
| `boardService.ts` | `buildBoard`: fetch, judge, and enrich the dashboard's repos in one call. |
| `stats.ts` | Who each commit is attributed to; totals for a range and a choice of who to compare; week buckets; which dates still need fetching. |
| `statsFetch.ts` | The Stats queries (merged PRs with their commits, repos created). |
| `statsService.ts` | `refreshStats`: bring the history up to date, fetching only what is new, and keep it in a `Store`. |
| `charts.ts` | The Stats charts as SVG strings: donut, stacked bars, weekly columns, legend. |
| `report.ts` | The full report: one self-contained HTML page (`renderReport`), plus how to open it. |
| `reportClient.generated.ts` | GENERATED: the report page's script, bundled from `src/report/client.ts`. Run `node scripts/build-report.mjs` after changing it. |
| `links.ts` | Where each part of a repo row links to, and the strict URL check the engine demands. |

Tests sit beside the code (`*.test.ts`) and run with `claude plugin test .`.

## The Claude engine's state contract is generated

The engine reads `types/index.d.ts` by itself and needs it self-contained, so it is **generated**
from `types.ts` (plus what is specific to the pane) by `node scripts/sync-contract.mjs`. After
changing `types.ts`, run it; CI fails if they differ.

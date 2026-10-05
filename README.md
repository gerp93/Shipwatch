# Shipwatch

A [Claude Code](https://claude.com/claude-code) mod that shows every repo under a GitHub
account or org on one dashboard pane: running builds, open PRs, and a stepper that says
where each repo is in the loop from pull request to release.

```
my-app      ● PR ─ ◐ Build ─ ○ Merged ─ ○ Released
  #42 building · pushed 4m ago
  ▸ CI · feature/login
  ◐ #42 Add login screen
```

It is built for the workflow of pushing changes, letting CI build, then downloading the
release. With several apps going at once it answers "which of these is waiting on me?"

## What you get

- **A pane** (`/shipwatch`): one block per repo that needs attention, ordered failing,
  building, ready to merge, awaiting release. Stale repos (old conflicted drafts and the
  like) and quiet ones collapse to one line each.
- **A status line entry**: `◐ 2 building · ✗ 1 failing · 7 open PRs`.
- **Toasts** when a build passes or fails, and when a new release is published.
- **Auto-fix (opt-in)**: a broken default-branch build can wake an idle session with a
  fix request, so a failure after an auto-merge doesn't wait for you to notice.
- **Adaptive polling**: every 20 s while something builds, every 60 s otherwise.
  Press `r` in the pane to refresh now.

### The stepper

| Step | Meaning |
|---|---|
| PR | An open pull request exists |
| Build | Its checks are running, passing or failing |
| Merged | The change is on the default branch |
| Released | A release has been published at or after the default branch's head commit |

With an open PR the stepper follows the most urgent one (conflicts or failing checks, then
running, then ready). With none it follows the default branch.

## Requirements

- Claude Code with function-hook plugins (the desktop Code tab or the CLI).
- The [`gh` CLI](https://cli.github.com/), signed in. Shipwatch runs `gh api` and never
  handles your token. If `gh` can't be run from where your session runs, set the
  `githubToken` option instead and it calls the GitHub API directly.

## Install

From GitHub, no clone needed:

```bash
claude plugin marketplace add gerp93/Shipwatch
claude plugin install shipwatch@shipwatch
```

Then start a new session and run `/shipwatch`. Set options with
`claude plugin configure shipwatch`.

To work on it instead, point Claude Code at a clone: `claude --plugin-dir /path/to/Shipwatch`,
or for sessions the desktop app starts, set `CLAUDE_CODE_PLUGIN_DIRS` (and
`CLAUDE_CODE_PLUGIN_DIR_WATCH=1` to reload on save) in the `env` block of `~/.claude/settings.json`.

## Options

| Option | Default | |
|---|---|---|
| `owner` | empty | User or org to watch. Empty means the account `gh` is signed in as. |
| `pollSeconds` | `60` | Refresh interval while nothing is building. |
| `maxRepos` | `40` | Most recently pushed repos to track (1-100). |
| `staleDays` | `14` | A repo with no push or PR activity for this long, and nothing building, moves to a collapsed Stale group (`s` toggles it). |
| `autoFix` | `false` | When a default-branch build goes from running to failing, queue a prompt in the session asking Claude to find the cause and open a fix PR (never a direct push). Starts its own turn once the session is idle. |
| `autoFixLimit` | `5` | Most fix prompts per session; one per failing commit. |
| `includeForks` | `false` | Also track forks. |
| `ignoreRepos` | empty | Comma-separated repo names to skip. |
| `githubToken` | empty | Fallback when `gh` can't run. Needs read access to repos. |

Archived repos are always skipped.

## Layout

```
.claude-plugin/plugin.json   manifest and options
hooks/register.tsx           pane, polling loop, command, toasts
hooks/analyze.ts             pure logic: repo -> stepper position, transitions
hooks/github.ts              GitHub access through injected gh/HTTP callbacks
types/index.d.ts             the shape of the board kept in session state
```

Check and test with:

```bash
claude plugin validate .
claude plugin test .
```

## Limits

- It sees what GitHub's check rollup reports. A repo with no CI shows no build step.
- "Released" is judged by release date against the head commit, so a repo that doesn't
  publish a release for every merge shows "unreleased commits" once the merge is a few
  hours old.
- Whether the new build is installed on your machine isn't tracked yet.

## License

AGPL-3.0. See [LICENSE](LICENSE).

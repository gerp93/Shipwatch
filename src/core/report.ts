// The full report: one self-contained HTML page (no network, no files beside it) holding the dashboard and
// the stats with filters, sorting and a drill-down per repo. The Claude pane writes it to disk and opens it;
// the app shows the same page. Pure text in, text out.
//
// The page's script is src/report/client.ts, bundled into reportClient.generated.ts by
// scripts/build-report.mjs (CI checks that it is up to date), so the numbers and charts on the page are
// computed by the same core code as everywhere else.

import { REPORT_CLIENT_JS } from './reportClient.generated'
import type { Board, StatsBoard } from './types'

/** What the page is generated from. Everything the page shows is derived from this, nothing is fetched. */
export type ReportData = {
  /** Epoch ms the data was taken; the page's "ago" and its date ranges count back from here. */
  generatedAt: number
  board: Pick<Board, 'owner' | 'repos'>
  stats: Pick<StatsBoard, 'prs' | 'repos' | 'you'>
}

const BS = String.fromCharCode(92)

/** JSON that is safe inside a <script> element: nothing in it can close the tag or start a comment. */
export const jsonForScript = (value: unknown): string =>
  JSON.stringify(value)
    .replace(/</g, `${BS}u003c`)
    .split(String.fromCharCode(0x2028))
    .join(`${BS}u2028`)
    .split(String.fromCharCode(0x2029))
    .join(`${BS}u2029`)

const CSS = `
:root{--bg:#fff;--fg:#1f2328;--dim:#656d76;--line:#d0d7de;--card:#f6f8fa;--accent:#0969da;--on:#0969da;--onfg:#fff;
--fail:#cf222e;--running:#9a6700;--ready:#1a7f37;--pending:#8250df;--draft:#6e7781;--idle:#8c959f}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--dim:#8d96a0;--line:#30363d;--card:#161b22;--accent:#58a6ff;--on:#1f6feb;--onfg:#fff;
--fail:#f85149;--running:#d29922;--ready:#3fb950;--pending:#a371f7;--draft:#8b949e;--idle:#6e7681}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
#app{max-width:1100px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:0}h3{margin:22px 0 8px;font-size:15px}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
.dim{color:var(--dim)}.grow{flex:1}.row{display:flex;gap:8px;align-items:center;margin:8px 0}.wrap{flex-wrap:wrap}.top{align-items:flex-start;gap:24px}
.btn{font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;cursor:pointer}
.btn.on{background:var(--on);color:var(--onfg);border-color:var(--on)}
.search{font:inherit;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:4px 10px;min-width:180px}
table{width:100%;border-collapse:collapse;margin:8px 0}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-weight:600;color:var(--dim);white-space:nowrap}th.sortable{cursor:pointer;user-select:none}tr.click{cursor:pointer}tr.click:hover{background:var(--card)}
table.compact{width:auto;min-width:340px}
.tiles{display:flex;gap:12px;flex-wrap:wrap;margin:12px 0}.tile{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 16px;min-width:130px}
.big{font-size:22px;font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;color:#fff;background:var(--idle);white-space:nowrap}
.pill.fail{background:var(--fail)}.pill.running{background:var(--running)}.pill.ready{background:var(--ready)}.pill.pending{background:var(--pending)}.pill.draft{background:var(--draft)}
.step{display:inline-block;font-size:12px;margin-right:6px;padding:0 6px;border-radius:4px;border:1px solid var(--line);color:var(--dim)}
.step.done{color:var(--ready);border-color:var(--ready)}.step.running{color:var(--running);border-color:var(--running)}.step.failed{color:var(--fail);border-color:var(--fail)}
.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px}
.chip{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:2px 4px 2px 10px}.x{font:inherit;background:none;border:0;color:var(--dim);cursor:pointer;padding:0 6px}
.svg{max-width:100%;overflow-x:auto}
`

/** The report page for `data`. */
export const renderReport = (data: ReportData): string => {
  const title = `${data.board.owner || data.stats.you || 'GitHub'} - Shipwatch`
  const safeTitle = title.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:\">" +
    `<title>${safeTitle}</title><style>${CSS}</style></head><body><div id="app"></div>` +
    `<script>window.SHIPWATCH_DATA=${jsonForScript(data)}</script>` +
    `<script>${REPORT_CLIENT_JS.replace(/<\/script/gi, '<\\/script')}</script></body></html>`
  )
}

/** The command that opens `path` in the default program: `start` on Windows, `open` on a Mac, `xdg-open` elsewhere. */
export const openArgv = (isWindows: boolean, isMac: boolean, path: string): string[] =>
  isWindows ? ['cmd', '/c', 'start', '', path.replace(/\//g, String.fromCharCode(92))] : [isMac ? 'open' : 'xdg-open', path]

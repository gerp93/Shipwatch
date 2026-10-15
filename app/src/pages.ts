// The small pages the window shows around the report: while loading, and when something went wrong. Plain
// strings, so they can be tested without Electron.

const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const STYLE =
  ':root{color-scheme:light dark}body{font:15px system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;' +
  'background:Canvas;color:CanvasText}main{max-width:560px;padding:24px}.dim{opacity:.7}pre{white-space:pre-wrap}' +
  '#bar{height:6px;border-radius:3px;background:rgba(128,128,128,.3);overflow:hidden;margin:16px 0}#bar>div{height:100%;width:0;background:#3fa66b;transition:width .4s}' +
  '#bar[data-indeterminate]>div{width:30%;animation:slide 1.2s ease-in-out infinite}@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}'

const page = (body: string, script = ''): string =>
  `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${script ? "; script-src 'unsafe-inline'" : ''}">` +
  `<title>Shipwatch</title><style>${STYLE}</style><main>${body}</main>${script ? `<script>${script}</script>` : ''}`

/** The loading page's own script: a running clock, and `setProgress(text, fraction)` for main to call. */
const LOADING_SCRIPT = `
const started = Date.now()
const clock = document.getElementById('t')
setInterval(() => {
  const s = Math.floor((Date.now() - started) / 1000)
  clock.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0')
}, 1000)
window.setProgress = (text, fraction) => {
  document.getElementById('p').textContent = text
  const bar = document.getElementById('bar')
  if (typeof fraction === 'number') {
    bar.removeAttribute('data-indeterminate')
    bar.firstElementChild.style.width = Math.round(fraction * 100) + '%'
  }
}
`

/**
 * How far along a loader message says it is, from 0 to 1, when it says ("... (part 3 of 13)"); otherwise
 * undefined and the bar keeps pulsing. The core words its progress as plain text, so this reads that text.
 */
export const progressFraction = (text: string): number | undefined => {
  const m = /part (\d+) of (\d+)/.exec(text)
  if (!m) return undefined
  const done = Number(m[1])
  const total = Number(m[2])
  return total > 0 ? Math.min(1, Math.max(0, (done - 1) / total)) : undefined
}

/** Shown while GitHub is being read: what it is doing, a bar, and how long it has been going. */
export const loadingPage = (): string =>
  page(
    '<h2>Shipwatch</h2><p>Reading your repos from GitHub...</p>' +
      '<div id="bar" data-indeterminate="1"><div></div></div>' +
      '<p class="dim" id="p">The first run also loads all of your merged-PR history, which can take a few minutes.</p>' +
      '<p class="dim">Running for <span id="t">0:00</span></p>',
    LOADING_SCRIPT,
  )

/** Shown when the report could not be built; says what to fix. */
export const errorPage = (message: string): string =>
  page(`<h2>Shipwatch could not read GitHub</h2><pre>${escapeHtml(message)}</pre><p class="dim">Fix that, then choose View, Refresh (Ctrl+R).</p>`)

/** Whether a link may be handed to the operating system: ordinary web links only, never file: or a shell handler. */
export const isSafeExternalUrl = (url: string): boolean => {
  try {
    const { protocol } = new URL(url)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

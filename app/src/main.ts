// Shipwatch app: one window showing the report page the core builds (src/core/report.ts). This file is only
// the Electron shell around it: it reads GitHub through the core, writes the page to the user-data folder,
// and shows it. All of what is shown, and how the numbers are worked out, is in the core.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { InfraVerdicts } from '../../src/core/boardService'
import { pace } from '../../src/core/budget'
import type { ApiLimits, Budget } from '../../src/core/budget'
import { fetchRecentPrs } from '../../src/core/recent'
import { renderReport } from '../../src/core/report'
import type { BoardStatus, ReportData, StatsStatus } from '../../src/core/report'
import { STATS_FRESH_MS } from '../../src/core/statsService'

import { FileStore, nodeIO } from './adapters'
import { HOUR_MS, RateLimited, collectDashboard, collectStats, loadSavedDashboard, saveDashboard, savedStats } from './collect'
import type { CollectDeps, DashboardRead } from './collect'
import { readConfig } from './config'
import { readEffort, transcriptsDir } from './effort'
import { setApiScript, setBoardScript, setBoardStatusScript, setEffortScript, setNextRefreshScript, setRecentScript, setStatsScript, setStatusScript, throttled } from './live'
import { closeFromReport, mergeFromReport } from './merge'
import { errorPage, isSafeExternalUrl, loadingPage, progressFraction } from './pages'
import { checkForUpdatesNow, setupAutoUpdater } from './updates'

const REPO_URL = 'https://github.com/gerp93/Shipwatch'

let win: BrowserWindow | undefined
let isRefreshing = false
const infraVerdicts: InfraVerdicts = new Map()
/** The account and open PRs (as `repo#number`) of the report on screen: the only PRs its Merge button may act on. */
let onScreen: { owner: string; prs: Set<string> } | undefined

const userFile = (name: string): string => join(app.getPath('userData'), name)
/** Files shipped inside the app (the icons), beside the bundled code whether run from source or packaged. */
const assetFile = (name: string): string => join(app.getAppPath(), 'assets', name)

/** The logo as a `data:` address for the report's header; the page has no network and no files beside it. */
const readLogo = async (): Promise<string | undefined> => {
  try {
    return `data:image/png;base64,${(await readFile(assetFile('logo.png'))).toString('base64')}`
  } catch {
    return undefined
  }
}

/** Shows `html` in the window without a file or a network address behind it. */
const showHtml = (html: string): Promise<void> => win!.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

async function loadConfig(): Promise<ReturnType<typeof readConfig>> {
  let file: unknown
  try {
    file = JSON.parse(await readFile(userFile('config.json'), 'utf8'))
  } catch {
    // No settings file: defaults.
  }
  return readConfig(file, process.env)
}

/** The stats history is read after the dashboard is on screen, one load at a time; the page is told how it goes. */
let isLoadingStats = false
let statsStatus: StatsStatus | null = null
let statsLoadedAt = 0
/** Set by the banner's "Fetch now": go on past the allowance reserve, and cut short a pause already under way. */
let spendReserveNow = false
let endPause: (() => void) | undefined
/** A timer the "Fetch now" button can end early. */
const pausableWait = (ms: number): Promise<void> =>
  new Promise(resolve => {
    const done = (): void => {
      clearTimeout(timer)
      if (endPause === done) endPause = undefined
      resolve()
    }
    const timer = setTimeout(done, ms)
    endPause = done
  })

/** A load that finished a moment ago is not repeated just because the dashboard was refreshed. */
const shouldLoadStats = (): boolean => spendReserveNow || Date.now() - statsLoadedAt >= STATS_FRESH_MS

/** Runs a line of script in the report on screen, if there is one; the page ignores it when it is not ready yet. */
const toPage = (script: string): void => void win?.webContents.executeJavaScript(script).catch(() => {})

/**
 * Step two: brings the history up to date, reading only what is not already saved, and shows the page the
 * history so far as it arrives and how far along it is. Whatever loads is saved as it goes, so a stop part way
 * (a rate limit, closing the app) costs nothing already read.
 */
async function loadStatsInBackground(deps: CollectDeps, read: DashboardRead): Promise<void> {
  isLoadingStats = true
  try {
    statsStatus = { state: 'loading', text: 'Starting...' }
    toPage(setStatusScript(statsStatus))
    const start = await savedStats(deps, read.owner)
    const sendPartial = throttled(2000, (stats: ReportData['stats']) => toPage(setStatsScript(stats)))
    const { stats, error } = await collectStats(
      {
        ...deps,
        spendReserve: () => spendReserveNow,
        wait: pausableWait,
        onProgress: text => {
          statsStatus = { state: 'loading', text, fraction: progressFraction(text) }
          toPage(setStatusScript(statsStatus))
        },
      },
      read,
      start,
      sendPartial,
    )
    toPage(setStatsScript({ prs: stats.prs, repos: stats.repos, you: stats.you }))
    statsStatus = error ? { state: 'error', text: error } : null
    toPage(setStatusScript(statsStatus))
    if (error) win?.setTitle(`Shipwatch - stats incomplete: ${error}`.slice(0, 120))
    else statsLoadedAt = Date.now()
  } catch (err) {
    statsStatus = { state: 'error', text: err instanceof Error ? err.message : String(err) }
    toPage(setStatusScript(statsStatus))
  } finally {
    isLoadingStats = false
    spendReserveNow = false
  }
}

/**
 * Session time and tokens per repo, from Claude Code's transcripts on this computer, for the Builds tab. Read in the
 * background (the first read parses every transcript; later ones only the files that changed) and handed to the page.
 */
let lastEffort: ReportData['effort']
let isReadingEffort = false
async function loadEffortInBackground(repoNames: readonly string[]): Promise<void> {
  if (isReadingEffort) return
  isReadingEffort = true
  try {
    lastEffort = await readEffort(transcriptsDir(), repoNames, userFile('effort.json'))
    toPage(setEffortScript(lastEffort))
  } catch {
    // The Builds tab then shows what GitHub holds, without session time.
  } finally {
    isReadingEffort = false
  }
}

/** True once the report is on screen: from then on, updates happen behind it and never replace it with a loading screen. */
let reportShown = false
let lastRead: DashboardRead | undefined
let lastApi: ApiLimits | undefined
let boardStatus: BoardStatus | null = null
let refreshTimer: NodeJS.Timeout | undefined
let recentTimer: NodeJS.Timeout | undefined
let recentBackoffUntil = 0

/** How often the dashboard is read again by itself (stretched when GitHub's allowance runs low), and how soon after a failed read. */
const REFRESH_MS = 2 * 60_000
const RETRY_AFTER_ERROR_MS = 5 * 60_000

/** Writes the report for `what` to the user-data folder and shows it. What is shown is what the app already knows. */
async function showReport(
  deps: CollectDeps,
  what: { owner: string; repos: DashboardRead['repos']; recent?: DashboardRead['recent']; at: number; boardStatus?: BoardStatus },
): Promise<void> {
  const saved = await savedStats(deps, what.owner)
  const data: ReportData = {
    generatedAt: what.at,
    board: { owner: what.owner, repos: what.repos },
    stats: { prs: saved.prs, repos: saved.repos, you: saved.you },
    statsStatus: isLoadingStats ? (statsStatus ?? undefined) : undefined,
    boardStatus: what.boardStatus,
    recentPrs: what.recent,
    effort: lastEffort,
    api: lastApi,
    nextRefreshAt,
    logo: await readLogo(),
  }
  // The report is a real file, not a data: address, because years of history are too big for one.
  const page = userFile('report.html')
  await writeFile(page, renderReport(data), 'utf8')
  onScreen = { owner: what.owner, prs: new Set(what.repos.flatMap(r => r.prs.map(p => `${r.name}#${p.number}`))) }
  await win?.loadFile(page)
  reportShown = true
  win?.setTitle('Shipwatch')
}

/** When the dashboard is next read; `null` while it is being read now. What the header's countdown counts to. */
let nextRefreshAt: number | null | undefined
const setNextRefresh = (at: number | null): void => {
  nextRefreshAt = at
  toPage(setNextRefreshScript(at))
}

const scheduleRefresh = (ms: number): void => {
  if (refreshTimer) clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => void refresh(), ms)
  setNextRefresh(Date.now() + ms)
}

/**
 * Brings the window up to date. What the app already knows (the dashboard it saved last time and the stats
 * history on disk) goes on screen straight away; GitHub is read behind it, with a banner saying so, and the
 * page is updated when it arrives. The loading screen is only for a very first start, when nothing is saved.
 */
async function refresh(): Promise<void> {
  if (isRefreshing || !win) return
  isRefreshing = true
  setNextRefresh(null)
  try {
    const config = await loadConfig()
    const base = { io: nodeIO(), store: new FileStore(userFile('stats.json')), config, infraVerdicts }

    if (!reportShown) {
      const saved = await loadSavedDashboard(userFile('board.json'))
      if (saved) await showReport({ ...base, now: Date.now() }, { ...saved, boardStatus: { state: 'loading', text: 'Starting...' } })
      else await showHtml(loadingPage())
    }
    const behind = reportShown
    if (behind) {
      boardStatus = { state: 'loading', text: 'Reading repos from GitHub...' }
      toPage(setBoardStatusScript(boardStatus))
    }

    const onProgress = (text: string): void => {
      if (behind) {
        boardStatus = { state: 'loading', text }
        toPage(setBoardStatusScript(boardStatus))
      } else {
        const fraction = progressFraction(text)
        void win?.webContents.executeJavaScript(`window.setProgress(${JSON.stringify(text)}, ${fraction ?? 'undefined'})`).catch(() => {})
      }
    }
    let read: DashboardRead
    const deps: CollectDeps = { ...base, now: Date.now(), onProgress }
    try {
      read = await collectDashboard(deps)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (!behind) throw err
      // The saved dashboard stays on screen; the banner says why it is not current and the update tries again later.
      boardStatus = { state: 'error', text: message }
      toPage(setBoardStatusScript(boardStatus))
      // A rate limit says when it resets (the message has the time); ask again then. Anything else, in a few minutes.
      scheduleRefresh(err instanceof RateLimited ? err.retryInMs : RETRY_AFTER_ERROR_MS)
      return
    }
    lastRead = read
    const known = (await savedStats(deps, read.owner)).repos.map(r => r.name)
    void loadEffortInBackground([...read.repos.map(r => r.name), ...known])
    await saveDashboard(userFile('board.json'), { owner: read.owner, repos: read.repos, recent: read.recent, at: deps.now })
    if (behind) {
      onScreen = { owner: read.owner, prs: new Set(read.repos.flatMap(r => r.prs.map(p => `${r.name}#${p.number}`))) }
      toPage(setBoardScript({ owner: read.owner, repos: read.repos }, deps.now, read.recent))
      boardStatus = null
      toPage(setBoardStatusScript(null))
    } else {
      await showReport(deps, { owner: read.owner, repos: read.repos, recent: read.recent, at: deps.now })
    }
    startLiveTimers()
    noteBudget(read.budget)
    if (!isLoadingStats && shouldLoadStats()) void loadStatsInBackground({ ...deps, onProgress: undefined }, read)
    scheduleRefresh(pace(read.budget, Date.now(), REFRESH_MS).delayMs)
  } catch (err) {
    await showHtml(errorPage(err instanceof Error ? err.message : String(err))).catch(() => {})
  } finally {
    isRefreshing = false
    // "Fetch now" applies to the attempt it started; it does not stay armed for a later, automatic one.
    if (!isLoadingStats) spendReserveNow = false
  }
}

/**
 * What is left of GitHub's GraphQL allowance, for the header's readout, taken from the `rateLimit` numbers GitHub
 * returns with every read (the dashboard's, and the last hour's each minute), so it costs nothing extra. GitHub's
 * separate REST rate-limit page is not used: it has reported a different count from GraphQL's own.
 */
function noteBudget(b: Budget | undefined): void {
  if (!b) return
  lastApi = { graphql: { remaining: b.remaining, limit: b.limit, resetAt: b.resetAt } }
  toPage(setApiScript(lastApi))
}

/** The last hour's PRs, for the clock's rim, read again each minute (one point) unless GitHub has been refusing. */
async function updateRecent(): Promise<void> {
  if (!lastRead || isRefreshing || Date.now() < recentBackoffUntil) return
  try {
    const recent = await fetchRecentPrs(nodeIO(), lastRead.access, lastRead.owner, Date.now() - HOUR_MS, noteBudget)
    lastRead = { ...lastRead, recent }
    toPage(setRecentScript(recent))
  } catch {
    recentBackoffUntil = Date.now() + RETRY_AFTER_ERROR_MS
  }
}

function startLiveTimers(): void {
  recentTimer ??= setInterval(() => void updateRecent(), 60_000)
}

function stopTimers(): void {
  for (const t of [refreshTimer, recentTimer]) if (t) clearTimeout(t)
  refreshTimer = recentTimer = undefined
}

function setupMenu(): void {
  const view: MenuItemConstructorOptions[] = [
    { label: 'Refresh', accelerator: 'CmdOrCtrl+R', click: () => void refresh() },
    // Developer items exist only when running from source.
    ...(app.isPackaged ? [] : ([{ role: 'forceReload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[])),
    { type: 'separator' },
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    // Electron's zoomIn binds only the first accelerator; these cover the physical + key and the numpad.
    { role: 'zoomIn', accelerator: 'CmdOrCtrl+Shift+=', visible: false },
    { role: 'zoomIn', accelerator: 'CmdOrCtrl+numadd', visible: false },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' },
  ]
  const help: MenuItemConstructorOptions[] = [
    { label: 'Shipwatch on GitHub', click: () => void shell.openExternal(REPO_URL) },
    { label: 'Report an issue', click: () => void shell.openExternal(`${REPO_URL}/issues/new`) },
    { label: 'Check for updates', click: () => void checkForUpdatesNow(() => win) },
    { type: 'separator' },
    { label: `Version ${app.getVersion()}`, enabled: false },
  ]
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? ([{ role: 'appMenu' }] as MenuItemConstructorOptions[]) : []),
    { label: 'View', submenu: view },
    { label: 'Help', submenu: help },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** The report's Merge button: only the report itself may ask, and the user is asked before anything is merged. */
function setupMerge(): void {
  /** One of the report's PR buttons: only the report itself may ask, and the user is asked before anything changes. */
  const register = (channel: string, verb: string, act: typeof mergeFromReport): void => {
    ipcMain.handle(channel, async (event, repo: unknown, number: unknown) => {
      const isReport = event.senderFrame?.url === pathToFileURL(userFile('report.html')).href
      if (!isReport || !win || !onScreen) return { ok: false, message: `${verb} is only available from the report.` }
      const result = await act(
        {
          io: nodeIO(),
          config: await loadConfig(),
          owner: onScreen.owner,
          known: onScreen.prs,
          confirm: async q => {
            const { response } = await dialog.showMessageBox(win!, {
              type: 'question',
              title: 'Shipwatch',
              message: q.title,
              detail: q.detail,
              buttons: [q.action, 'Cancel'],
              defaultId: 1,
              cancelId: 1,
              noLink: true,
            })
            return response === 0
          },
        },
        repo,
        number,
      )
      // GitHub changed, so the report on screen is stale: read it again.
      if (result.changed) void refresh()
      return { ok: result.ok, message: result.message }
    })
  }
  register('shipwatch:merge', 'Merge', mergeFromReport)
  register('shipwatch:close', 'Close', closeFromReport)
}

/**
 * The banners' "Fetch now": do what is waiting to be retried right away. A dashboard update that GitHub refused is
 * tried again now instead of at the reset time, a stats load paused to keep the allowance reserve goes on at once,
 * and the stats load that follows spends that reserve. Only the report may ask.
 */
function setupFetchNow(): void {
  ipcMain.handle('shipwatch:fetch-now', async event => {
    const isReport = event.senderFrame?.url === pathToFileURL(userFile('report.html')).href
    if (!isReport || !win) return { ok: false, message: 'Only the report can ask for this.' }
    spendReserveNow = true
    // A load already under way (paused to keep the reserve) goes on at once instead of waiting out the pause.
    endPause?.()
    if (isRefreshing) return { ok: true, message: isLoadingStats ? 'Going on now, without pausing.' : 'Already trying; going on without pausing.' }
    if (isLoadingStats) return { ok: true, message: 'Going on now, without pausing.' }
    // Not waiting for the retry time GitHub gave: ask again now (a refresh also starts the stats load when it is due).
    if (refreshTimer) clearTimeout(refreshTimer)
    void refresh()
    return { ok: true, message: 'Trying now.' }
  })
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1180,
    height: 840,
    title: 'Shipwatch',
    icon: assetFile('icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(__dirname, 'preload.js') },
  })

  // Links in the report open in the user's browser, and only ordinary web links do.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  // The window never navigates away from its own pages.
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('data:') && !url.startsWith('file:')) {
      event.preventDefault()
      if (isSafeExternalUrl(url)) void shell.openExternal(url)
    }
  })
  // Without an Edit menu, right-click still reaches copy and select all.
  win.webContents.on('context-menu', (_event, params) => {
    const items: MenuItemConstructorOptions[] = []
    if (params.editFlags.canCopy) items.push({ role: 'copy' })
    if (params.editFlags.canSelectAll) items.push({ role: 'selectAll' })
    if (items.length > 0) Menu.buildFromTemplate(items).popup()
  })
  win.on('closed', () => {
    win = undefined
    reportShown = false
    stopTimers()
  })
}

// One copy of the app: a second launch brings the first to the front instead of reading GitHub twice.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(() => {
    setupMenu()
    setupMerge()
    setupFetchNow()
    createWindow()
    void refresh()
    setupAutoUpdater(() => win)
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow()
        void refresh()
      }
    })
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

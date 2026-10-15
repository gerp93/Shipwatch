// Shipwatch app: one window showing the report page the core builds (src/core/report.ts). This file is only
// the Electron shell around it: it reads GitHub through the core, writes the page to the user-data folder,
// and shows it. All of what is shown, and how the numbers are worked out, is in the core.

import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { InfraVerdicts } from '../../src/core/boardService'
import { renderReport } from '../../src/core/report'
import type { ReportData, StatsStatus } from '../../src/core/report'
import { STATS_FRESH_MS } from '../../src/core/statsService'

import { FileStore, nodeIO } from './adapters'
import { collectDashboard, collectStats, savedStats } from './collect'
import type { CollectDeps, DashboardRead } from './collect'
import { readConfig } from './config'
import { setStatsScript, setStatusScript, throttled } from './live'
import { mergeFromReport } from './merge'
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

/** A load that finished a moment ago is not repeated just because the dashboard was refreshed. */
const shouldLoadStats = (): boolean => Date.now() - statsLoadedAt >= STATS_FRESH_MS

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
  }
}

async function refresh(): Promise<void> {
  if (isRefreshing || !win) return
  isRefreshing = true
  try {
    await showHtml(loadingPage())
    const say = (text: string): void => {
      const fraction = progressFraction(text)
      void win?.webContents.executeJavaScript(`window.setProgress(${JSON.stringify(text)}, ${fraction ?? 'undefined'})`).catch(() => {})
    }
    const config = await loadConfig()
    const deps: CollectDeps = {
      io: nodeIO(),
      store: new FileStore(userFile('stats.json')),
      config,
      now: Date.now(),
      infraVerdicts,
      onProgress: say,
    }
    // Step one: the dashboard, which is quick. The window shows it as soon as it is read, with whatever stats
    // history is already saved; the slow part (older history) is read afterwards, in the background.
    const read = await collectDashboard(deps)
    const saved = await savedStats(deps, read.owner)
    onScreen = { owner: read.owner, prs: new Set(read.repos.flatMap(r => r.prs.map(p => `${r.name}#${p.number}`))) }
    const loadingStats = isLoadingStats || shouldLoadStats()
    const status: StatsStatus | undefined = isLoadingStats ? (statsStatus ?? undefined) : loadingStats ? { state: 'loading', text: 'Starting...' } : undefined
    // The report is a real file, not a data: address, because years of history are too big for one.
    const page = userFile('report.html')
    const data: ReportData = {
      generatedAt: deps.now,
      board: { owner: read.owner, repos: read.repos },
      stats: { prs: saved.prs, repos: saved.repos, you: saved.you },
      statsStatus: status,
      logo: await readLogo(),
    }
    await writeFile(page, renderReport(data), 'utf8')
    await win.loadFile(page)
    win.setTitle('Shipwatch')
    if (!isLoadingStats && loadingStats) void loadStatsInBackground({ ...deps, onProgress: undefined }, read)
  } catch (err) {
    await showHtml(errorPage(err instanceof Error ? err.message : String(err))).catch(() => {})
  } finally {
    isRefreshing = false
  }
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
  ipcMain.handle('shipwatch:merge', async (event, repo: unknown, number: unknown) => {
    const isReport = event.senderFrame?.url === pathToFileURL(userFile('report.html')).href
    if (!isReport || !win || !onScreen) return { ok: false, message: 'Merge is only available from the report.' }
    const result = await mergeFromReport(
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

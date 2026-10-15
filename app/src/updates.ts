// Self-update for the packaged app, through electron-updater (the KVG standard for Electron apps): it reads the
// GitHub Release the installers are published to. A build run from source never updates itself.

import { app, dialog } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'

/** Looks for an update once at start-up and installs it when the app next quits, offering a restart now. */
export function setupAutoUpdater(getWindow: () => BrowserWindow | undefined): void {
  if (!app.isPackaged) return
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-downloaded', info => {
    const win = getWindow()
    const options = {
      type: 'info' as const,
      title: 'Update ready',
      message: `Shipwatch ${info.version} has been downloaded.`,
      detail: 'Restart now to install it, or it will install the next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    }
    void (win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)).then(result => {
      if (result.response === 0) autoUpdater.quitAndInstall()
    })
  })
  autoUpdater.on('error', err => console.error('Auto-update error:', err))
  autoUpdater.checkForUpdates().catch(err => console.error('Failed to check for updates:', err))
}

/** Help, Check for updates: says what it found, so the answer is never silence. */
export async function checkForUpdatesNow(getWindow: () => BrowserWindow | undefined): Promise<void> {
  const win = getWindow()
  const say = (message: string, detail?: string): Promise<unknown> => {
    const options = { type: 'info' as const, title: 'Shipwatch', message, detail }
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  }
  if (!app.isPackaged) {
    await say('Updates are only checked in the installed app.', 'This copy is running from source.')
    return
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    const latest = result?.updateInfo.version
    if (latest && latest !== app.getVersion()) await say(`Shipwatch ${latest} is available.`, 'It is downloading and will be offered for install when it is ready.')
    else await say('Shipwatch is up to date.', `Version ${app.getVersion()}`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // A release's installer is uploaded before its update manifest; a check in that gap cannot find it yet.
    await say('Could not check for updates.', message.includes('Cannot find latest') ? 'A new version may still be uploading. Try again in a few minutes.' : message)
  }
}

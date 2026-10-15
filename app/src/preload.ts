// Runs in the report page before its own script. It hands the page one thing: a way to ask the app to merge a PR.
// The page gets no other access; the app (main.ts) checks the request and asks the user before anything happens.

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('shipwatch', {
  mergePr: (repo: string, number: number): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('shipwatch:merge', repo, number),
})

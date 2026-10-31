/** Narrow preload, installed only on the registered companion windows. */
import { contextBridge, ipcRenderer } from 'electron'
import { COMPANION_IPC, type CompanionApi, type CompanionSnapshot, type CompanionResult, type CompanionCatalog } from './companion/api.ts'

if (process.isMainFrame && location.protocol === 'dsh-app:' && location.hostname === 'companion') {
  const api: CompanionApi = {
    platform: process.platform,
    command: command => ipcRenderer.invoke(COMPANION_IPC.command, command) as Promise<CompanionResult>,
    catalog: () => ipcRenderer.invoke(COMPANION_IPC.catalog) as Promise<CompanionResult<CompanionCatalog>>,
    subscribe(listener) {
      let epoch: string | undefined
      let revision = -1
      const receive = (_event: Electron.IpcRendererEvent, snapshot: CompanionSnapshot): void => {
        if (epoch === snapshot.bridgeEpoch && snapshot.revision <= revision) return
        epoch = snapshot.bridgeEpoch
        revision = snapshot.revision
        listener(snapshot)
      }
      ipcRenderer.on(COMPANION_IPC.snapshot, receive)
      ipcRenderer.send(COMPANION_IPC.subscribe)
      return () => { ipcRenderer.off(COMPANION_IPC.snapshot, receive); ipcRenderer.send(COMPANION_IPC.unsubscribe) }
    },
    onReveal(listener) {
      const receive = (_event: Electron.IpcRendererEvent, view: 'chat' | 'reply' | 'settings' | 'avatar'): void => { listener(view) }
      ipcRenderer.on(COMPANION_IPC.reveal, receive)
      return () => { ipcRenderer.off(COMPANION_IPC.reveal, receive) }
    },
  }
  contextBridge.exposeInMainWorld('dshCompanion', api)
}

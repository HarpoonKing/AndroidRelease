import { contextBridge, ipcRenderer } from 'electron'
import type { App, ReleaseTask, TaskLog } from '../db/schema'
import type { CredentialField } from '../services/base'

export type Platform = { id: string; displayName: string }

const api = {
  // Apps
  apps: {
    list: (): Promise<App[]> => ipcRenderer.invoke('apps:list'),
    create: (payload: { name: string; bundleId: string; iconPath?: string }): Promise<App> =>
      ipcRenderer.invoke('apps:create', payload),
    update: (payload: { id: number; name: string; bundleId: string; iconPath?: string | null }): Promise<App> =>
      ipcRenderer.invoke('apps:update', payload),
    delete: (appId: number): Promise<{ ok: boolean }> => ipcRenderer.invoke('apps:delete', appId)
  },

  // Credentials
  credentials: {
    save: (payload: {
      appId: number
      platform: string
      credentials: Record<string, string>
    }): Promise<{ ok: boolean }> => ipcRenderer.invoke('credentials:save', payload),
    getConfiguredPlatforms: (appId: number): Promise<string[]> =>
      ipcRenderer.invoke('credentials:getConfiguredPlatforms', appId),
    schema: (platform: string): Promise<CredentialField[]> =>
      ipcRenderer.invoke('credentials:schema', platform),
    get: (payload: {
      appId: number
      platform: string
    }): Promise<Record<string, string> | null> =>
      ipcRenderer.invoke('credentials:get', payload),
    verify: (payload: {
      platform: string
      credentials: Record<string, string>
    }): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke('credentials:verify', payload),
    copyFrom: (payload: {
      fromAppId: number
      toAppId: number
    }): Promise<{ ok: boolean; count: number }> =>
      ipcRenderer.invoke('credentials:copyFrom', payload)
  },

  // APK metadata
  apk: {
    readMeta: (apkPath: string): Promise<{ versionName: string; versionCode: number }> =>
      ipcRenderer.invoke('apk:readMeta', apkPath)
  },

  // Platforms
  platforms: {
    list: (): Promise<Platform[]> => ipcRenderer.invoke('platforms:list')
  },

  // Tasks
  tasks: {
    create: (payload: {
      appId: number
      platforms: string[]
      /** platform id → apk path，未出现的 platform 回退到 defaultApkPath */
      platformApks: Record<string, string>
      defaultApkPath?: string
      versionName: string
      versionCode: number
      releaseNotes?: string
      scheduledPublishAt?: string
    }): Promise<{ taskIds: number[] }> => ipcRenderer.invoke('tasks:create', payload),
    list: (filters?: { appId?: number }): Promise<ReleaseTask[]> =>
      ipcRenderer.invoke('tasks:list', filters),
    logs: (taskId: number): Promise<TaskLog[]> => ipcRenderer.invoke('tasks:logs', taskId),
    retry: (taskId: number): Promise<{ ok: boolean }> => ipcRenderer.invoke('tasks:retry', taskId),
    manualConfirmAudit: (taskId: number): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke('tasks:manualConfirmAudit', taskId),
    cancel: (taskId: number): Promise<{ ok: boolean }> => ipcRenderer.invoke('tasks:cancel', taskId),
    delete: (taskId: number): Promise<{ ok: boolean; message?: string }> =>
      ipcRenderer.invoke('tasks:delete', taskId)
  },

  // File dialogs
  dialog: {
    openApk: (): Promise<string | null> => ipcRenderer.invoke('dialog:openApk'),
    openImage: (): Promise<string | null> => ipcRenderer.invoke('dialog:openImage')
  },

  // Events from main process
  on: {
    taskLog: (
      cb: (data: { taskId: number; level: string; message: string; createdAt: Date }) => void
    ) => {
      const handler = (_: Electron.IpcRendererEvent, data: unknown) => cb(data as never)
      ipcRenderer.on('task:log', handler)
      return () => ipcRenderer.removeListener('task:log', handler)
    },
    taskStatusChanged: (cb: (data: { taskId: number; status: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: unknown) => cb(data as never)
      ipcRenderer.on('task:statusChanged', handler)
      return () => ipcRenderer.removeListener('task:statusChanged', handler)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)

export type API = typeof api

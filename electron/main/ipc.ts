import { ipcMain, safeStorage, dialog, BrowserWindow, app as electronApp } from 'electron'
import { getDb } from '../db'
import { apps, platformCredentials, releaseTasks, taskLogs } from '../db/schema'
import { eq, and, desc } from 'drizzle-orm'
import { getService, getAllServices } from '../services'
import { startUploadTask, manualConfirmAuditPassed, cancelTask } from './task-manager'
import type { NewReleaseTask } from '../db/schema'
import ApkReader from 'adbkit-apkreader'
import axios from 'axios'
import { access, copyFile, mkdir, rm } from 'fs/promises'
import { extname, join } from 'path'

function extractErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status
    const data = err.response?.data
    const body = data?.error_description || data?.error || data?.msg || data?.message
    if (body) return `${body}${status ? ` (HTTP ${status})` : ''}`
    if (status === 401) return '凭证无效，请检查 Client ID / Secret 是否正确 (HTTP 401)'
    if (status === 403) return '无访问权限，请确认 API 权限已开启 (HTTP 403)'
    if (status === 502 || status === 503 || status === 504)
      return `服务器暂时不可用，请稍后重试 (HTTP ${status})`
    if (!err.response) return `网络连接失败，请检查网络设置: ${err.message}`
    return `请求失败 (HTTP ${status}): ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}

// ─── Helper: verify the IPC sender is our main window ───────────────────────
function verifySender(event: Electron.IpcMainInvokeEvent): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win || event.senderFrame.routingId !== win.webContents.mainFrame.routingId) {
    throw new Error('Untrusted IPC sender')
  }
}

function getManagedIconsDir(): string {
  return join(electronApp.getPath('userData'), 'app-icons')
}

function isManagedIconPath(iconPath: string | null | undefined): boolean {
  if (!iconPath) return false
  return iconPath.startsWith(`${getManagedIconsDir()}/`) || iconPath.startsWith(`${getManagedIconsDir()}\\`)
}

async function persistAppIcon(sourcePath: string, appId: number): Promise<string> {
  await mkdir(getManagedIconsDir(), { recursive: true })
  const ext = extname(sourcePath).toLowerCase()
  const safeExt = ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp' ? ext : '.png'
  const targetPath = join(getManagedIconsDir(), `app-${appId}-${Date.now()}${safeExt}`)
  await copyFile(sourcePath, targetPath)
  return targetPath
}

async function cleanupManagedIcon(iconPath: string | null | undefined): Promise<void> {
  if (!isManagedIconPath(iconPath)) return
  await rm(iconPath!, { force: true })
}

// ─── Apps ─────────────────────────────────────────────────────────────────────
ipcMain.handle('apps:list', (event) => {
  verifySender(event)
  const db = getDb()
  return db.select().from(apps).orderBy(desc(apps.createdAt)).all()
})

ipcMain.handle(
  'apps:create',
  async (event, payload: { name: string; appAlias?: string; bundleId: string; iconPath?: string; apkRootDir?: string }) => {
  verifySender(event)
  const db = getDb()
  const created = db
    .insert(apps)
    .values({
      name: payload.name,
      appAlias: payload.appAlias ?? null,
      bundleId: payload.bundleId,
      apkRootDir: payload.apkRootDir ?? null
    })
    .returning()
    .get()
  if (!payload.iconPath) return created

  const managedIconPath = await persistAppIcon(payload.iconPath, created.id)
  const result = db
    .update(apps)
    .set({ iconPath: managedIconPath })
    .where(eq(apps.id, created.id))
    .returning()
    .get()
  return result
}
)

ipcMain.handle(
  'apps:update',
  async (
    event,
    payload: {
      id: number
      name: string
      appAlias?: string | null
      bundleId: string
      iconPath?: string | null
      apkRootDir?: string | null
    }
  ) => {
    verifySender(event)
    const db = getDb()
    const existing = db.select().from(apps).where(eq(apps.id, payload.id)).get()
    if (!existing) throw new Error('App 不存在')

    let nextIconPath = existing.iconPath
    if (payload.iconPath === null) {
      await cleanupManagedIcon(existing.iconPath)
      nextIconPath = null
    } else if (payload.iconPath && payload.iconPath !== existing.iconPath) {
      const managedIconPath = await persistAppIcon(payload.iconPath, payload.id)
      await cleanupManagedIcon(existing.iconPath)
      nextIconPath = managedIconPath
    }

    return db
      .update(apps)
      .set({
        name: payload.name,
        appAlias: payload.appAlias ?? null,
        bundleId: payload.bundleId,
        iconPath: nextIconPath,
        apkRootDir: payload.apkRootDir ?? null
      })
      .where(eq(apps.id, payload.id))
      .returning()
      .get()
  }
)

ipcMain.handle('apps:delete', async (event, appId: number) => {
  verifySender(event)
  const db = getDb()
  const existing = db.select().from(apps).where(eq(apps.id, appId)).get()
  await cleanupManagedIcon(existing?.iconPath)
  db.delete(apps).where(eq(apps.id, appId)).run()
  return { ok: true }
})

// ─── Credentials ──────────────────────────────────────────────────────────────
ipcMain.handle(
  'credentials:save',
  (event, payload: { appId: number; platform: string; credentials: Record<string, string> }) => {
    verifySender(event)
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统加密服务不可用，无法安全存储凭证')
    }

    const json = JSON.stringify(payload.credentials)
    const encrypted = safeStorage.encryptString(json)
    const encryptedBlob = encrypted.toString('base64')

    const db = getDb()
    // Upsert
    const existing = db
      .select()
      .from(platformCredentials)
      .where(
        and(
          eq(platformCredentials.appId, payload.appId),
          eq(platformCredentials.platform, payload.platform)
        )
      )
      .get()

    if (existing) {
      db.update(platformCredentials)
        .set({ encryptedBlob, updatedAt: new Date() })
        .where(eq(platformCredentials.id, existing.id))
        .run()
    } else {
      db.insert(platformCredentials)
        .values({ appId: payload.appId, platform: payload.platform, encryptedBlob })
        .run()
    }

    return { ok: true }
  }
)

ipcMain.handle(
  'credentials:getConfiguredPlatforms',
  (event, appId: number) => {
    verifySender(event)
    const db = getDb()
    const rows = db
      .select({ platform: platformCredentials.platform })
      .from(platformCredentials)
      .where(eq(platformCredentials.appId, appId))
      .all()
    return rows.map((r) => r.platform)
  }
)

ipcMain.handle(
  'credentials:get',
  (event, payload: { appId: number; platform: string }) => {
    verifySender(event)
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error('系统加密服务不可用')
    }
    const db = getDb()
    const row = db
      .select({ encryptedBlob: platformCredentials.encryptedBlob })
      .from(platformCredentials)
      .where(
        and(
          eq(platformCredentials.appId, payload.appId),
          eq(platformCredentials.platform, payload.platform)
        )
      )
      .get()
    if (!row) return null
    const json = safeStorage.decryptString(Buffer.from(row.encryptedBlob, 'base64'))
    return JSON.parse(json) as Record<string, string>
  }
)

ipcMain.handle('credentials:schema', (event, platform: string) => {
  verifySender(event)
  const svc = getService(platform)
  return svc.getCredentialSchema()
})

ipcMain.handle(
  'credentials:verify',
  async (event, payload: { platform: string; credentials: Record<string, string> }) => {
    verifySender(event)
    const svc = getService(payload.platform)
    if (!svc.verify) {
      return { ok: false, message: '该平台暂不支持凭证验证' }
    }
    try {
      await svc.verify(payload.credentials)
      return { ok: true, message: '验证通过，凭证有效' }
    } catch (err: unknown) {
      return { ok: false, message: extractErrorMessage(err) }
    }
  }
)

ipcMain.handle(
  'credentials:copyFrom',
  (event, payload: { fromAppId: number; toAppId: number }) => {
    verifySender(event)
    const db = getDb()
    const rows = db
      .select()
      .from(platformCredentials)
      .where(eq(platformCredentials.appId, payload.fromAppId))
      .all()
    for (const row of rows) {
      const existing = db
        .select()
        .from(platformCredentials)
        .where(
          and(
            eq(platformCredentials.appId, payload.toAppId),
            eq(platformCredentials.platform, row.platform)
          )
        )
        .get()
      if (!existing) {
        db.insert(platformCredentials)
          .values({ appId: payload.toAppId, platform: row.platform, encryptedBlob: row.encryptedBlob })
          .run()
      }
    }
    return { ok: true, count: rows.length }
  }
)

// ─── Platforms ────────────────────────────────────────────────────────────────
ipcMain.handle('platforms:list', (event) => {
  verifySender(event)
  return getAllServices().map((s) => ({
    id: s.platform,
    displayName: s.displayName
  }))
})

// ─── Tasks ────────────────────────────────────────────────────────────────────
ipcMain.handle(
  'tasks:create',
  async (
    event,
    payload: {
      appId: number
      platforms: string[]
      /** platform id → apk path */
      platformApks: Record<string, string>
      defaultApkPath?: string
      versionName: string
      versionCode: number
      releaseNotes?: string
      scheduledPublishAt?: string // ISO string or null
    }
  ) => {
    verifySender(event)
    const db = getDb()
    const createdIds: number[] = []

    for (const platform of payload.platforms) {
      const apkPath = payload.platformApks[platform] ?? payload.defaultApkPath
      if (!apkPath) {
        throw new Error(`平台 ${platform} 未指定 APK 文件`)
      }
      const task: NewReleaseTask = {
        appId: payload.appId,
        platform,
        apkPath,
        versionName: payload.versionName,
        versionCode: payload.versionCode,
        releaseNotes: payload.releaseNotes,
        scheduledPublishAt: payload.scheduledPublishAt ? new Date(payload.scheduledPublishAt) : null,
        status: 'uploading'
      }
      const created = db.insert(releaseTasks).values(task).returning().get()
      createdIds.push(created.id)
      // Start upload in background (don't await all at once to avoid blocking IPC)
      startUploadTask(created.id).catch(console.error)
    }

    return { taskIds: createdIds }
  }
)

ipcMain.handle('tasks:list', (event, filters?: { appId?: number }) => {
  verifySender(event)
  const db = getDb()
  let query = db.select().from(releaseTasks).$dynamic()
  if (filters?.appId) {
    query = query.where(eq(releaseTasks.appId, filters.appId))
  }
  return query.orderBy(desc(releaseTasks.createdAt)).limit(200).all()
})

ipcMain.handle('tasks:logs', (event, taskId: number) => {
  verifySender(event)
  const db = getDb()
  return db
    .select()
    .from(taskLogs)
    .where(eq(taskLogs.taskId, taskId))
    .orderBy(taskLogs.createdAt)
    .all()
})

ipcMain.handle('tasks:retry', async (event, taskId: number) => {
  verifySender(event)
  const db = getDb()
  db.update(releaseTasks)
    .set({ status: 'uploading', auditTaskId: null })
    .where(eq(releaseTasks.id, taskId))
    .run()
  startUploadTask(taskId).catch(console.error)
  return { ok: true }
})

ipcMain.handle('tasks:manualConfirmAudit', (event, taskId: number) => {
  verifySender(event)
  manualConfirmAuditPassed(taskId)
  return { ok: true }
})

ipcMain.handle('tasks:cancel', (event, taskId: number) => {
  verifySender(event)
  cancelTask(taskId)
  return { ok: true }
})

ipcMain.handle('tasks:delete', (event, taskId: number) => {
  verifySender(event)
  const db = getDb()
  const task = db.select().from(releaseTasks).where(eq(releaseTasks.id, taskId)).get()
  if (!task) {
    return { ok: false, message: '任务不存在' }
  }

  const activeStatuses = new Set(['uploading', 'pending_review', 'scheduled', 'publishing'])
  if (activeStatuses.has(task.status)) {
    return { ok: false, message: '请先终止运行中的任务，再删除' }
  }

  db.delete(releaseTasks).where(eq(releaseTasks.id, taskId)).run()
  return { ok: true }
})

// ─── File picker ──────────────────────────────────────────────────────────────
ipcMain.handle('dialog:openApk', async (event) => {
  verifySender(event)
  const result = await dialog.showOpenDialog({
    title: '选择 APK 文件',
    filters: [{ name: 'Android Package', extensions: ['apk'] }],
    properties: ['openFile']
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:openImage', async (event) => {
  verifySender(event)
  const result = await dialog.showOpenDialog({
    title: '选择 App 图标',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
    properties: ['openFile']
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('dialog:openDirectory', async (event) => {
  verifySender(event)
  const result = await dialog.showOpenDialog({
    title: '选择 APK 根目录',
    properties: ['openDirectory']
  })
  return result.canceled ? null : result.filePaths[0]
})

// ─── APK metadata ─────────────────────────────────────────────────────────────
ipcMain.handle('apk:readMeta', async (event, apkPath: string) => {
  verifySender(event)
  const reader = await ApkReader.open(apkPath)
  const manifest = await reader.readManifest()
  return {
    versionName: manifest.versionName ?? '',
    versionCode: manifest.versionCode ?? 0
  }
})

ipcMain.handle(
  'apk:autoMatchByRule',
  async (
    event,
    payload: { appId: number; releaseVersion: string; platforms: string[] }
  ) => {
    verifySender(event)
    const db = getDb()
    const app = db.select().from(apps).where(eq(apps.id, payload.appId)).get()
    if (!app) {
      throw new Error('App 不存在')
    }
    const alias = (app.appAlias ?? '').trim()
    if (!alias) {
      throw new Error('当前 App 未设置别名，请先到 App 管理页配置')
    }
    const apkRootDir = (app.apkRootDir ?? '').trim()
    if (!apkRootDir) {
      throw new Error('当前 App 未设置 APK 根目录，请先到 App 管理页配置')
    }
    const releaseVersion = payload.releaseVersion.trim()
    if (!releaseVersion) {
      throw new Error('请先填写 App 版号')
    }

    // Version must be three numeric parts like 1.2.5, and filename uses 125.
    const versionParts = releaseVersion.split('.')
    if (versionParts.length !== 3 || versionParts.some((p) => !/^\d+$/.test(p))) {
      throw new Error('App 版号格式需为三段数字，例如 1.2.5')
    }
    const compactVersion = versionParts.join('')

    const ruleMap: Record<string, { seq: number; name: string }> = {
      huawei: { seq: 1, name: 'huawei' },
      yingyongbao: { seq: 2, name: 'tencent' },
      vivo: { seq: 3, name: 'vivo' },
      oppo: { seq: 4, name: 'oppo' },
      xiaomi: { seq: 5, name: 'xiaomi' },
      honor: { seq: 6, name: 'hihonor' }
    }

    const matched: Record<string, string> = {}
    const missing: Array<{ platform: string; expectedFileName: string; expectedPath: string; reason?: string }> = []

    for (const platform of payload.platforms) {
      const rule = ruleMap[platform]
      if (!rule) {
        missing.push({
          platform,
          expectedFileName: '',
          expectedPath: '',
          reason: '该平台未配置自动匹配规则'
        })
        continue
      }

      const expectedFileName = `${alias}_${compactVersion}_${rule.seq}_${rule.name}_sign.apk`
      const expectedPath = join(apkRootDir, releaseVersion, expectedFileName)

      try {
        await access(expectedPath)
        matched[platform] = expectedPath
      } catch {
        missing.push({ platform, expectedFileName, expectedPath })
      }
    }

    return { matched, missing }
  }
)

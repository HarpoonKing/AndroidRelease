import { safeStorage, BrowserWindow } from 'electron'
import axios from 'axios'
import { getDb } from '../db'
import { platformCredentials, releaseTasks, taskLogs, apps } from '../db/schema'
import { getService, PlatformNoPollingError } from '../services'
import { eq, and, inArray } from 'drizzle-orm'

type TaskStatus =
  | 'uploading'
  | 'upload_failed'
  | 'pending_review'
  | 'audit_failed'
  | 'audit_passed'
  | 'scheduled'
  | 'publishing'
  | 'published'
  | 'publish_failed'
  | 'canceled'

const canceledTaskIds = new Set<number>()

function getMainWindow(): BrowserWindow | null {
  const wins = BrowserWindow.getAllWindows()
  return wins.length > 0 ? wins[0] : null
}

function pushLog(taskId: number, level: string, message: string): void {
  const db = getDb()
  db.insert(taskLogs).values({ taskId, level, message }).run()
  getMainWindow()?.webContents.send('task:log', { taskId, level, message, createdAt: new Date() })
}

function truncate(text: string, max = 1200): string {
  return text.length > max ? `${text.slice(0, max)}…(截断)` : text
}

function safeStringify(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function getAxiosErrorDetails(err: unknown): string[] {
  if (!axios.isAxiosError(err)) return []

  const lines: string[] = []
  const method = (err.config?.method || 'GET').toUpperCase()
  const baseURL = err.config?.baseURL ?? ''
  const url = `${baseURL}${err.config?.url ?? ''}` || 'unknown-url'
  lines.push(`HTTP ${err.response?.status ?? 'N/A'} ${method} ${url}`)

  if (err.code) lines.push(`Axios code: ${err.code}`)
  if (err.message) lines.push(`Axios message: ${err.message}`)

  const responseData = err.response?.data
  if (responseData !== undefined) {
    lines.push(`Response body: ${truncate(safeStringify(responseData))}`)
  }

  const requestData = (err.config as { data?: unknown } | undefined)?.data
  if (requestData !== undefined) {
    const body = typeof requestData === 'string' ? requestData : safeStringify(requestData)
    lines.push(`Request body: ${truncate(body)}`)
  }

  return lines
}

function logDetailedError(taskId: number, prefix: string, err: unknown): void {
  const baseMsg = err instanceof Error ? err.message : String(err)
  pushLog(taskId, 'error', `${prefix}: ${baseMsg}`)

  for (const line of getAxiosErrorDetails(err)) {
    pushLog(taskId, 'error', `- ${line}`)
  }

  if (err instanceof Error && err.stack) {
    pushLog(taskId, 'error', `Stack: ${truncate(err.stack)}`)
  }
}

function updateTaskStatus(taskId: number, status: TaskStatus, extra?: Partial<typeof releaseTasks.$inferInsert>): void {
  const db = getDb()
  db.update(releaseTasks)
    .set({ status, ...extra })
    .where(eq(releaseTasks.id, taskId))
    .run()
  getMainWindow()?.webContents.send('task:statusChanged', { taskId, status })
}

function isTaskCanceled(taskId: number): boolean {
  if (canceledTaskIds.has(taskId)) return true
  const db = getDb()
  const row = db
    .select({ status: releaseTasks.status })
    .from(releaseTasks)
    .where(eq(releaseTasks.id, taskId))
    .get()
  return row?.status === 'canceled'
}

export function cancelTask(taskId: number): void {
  canceledTaskIds.add(taskId)
  updateTaskStatus(taskId, 'canceled', { completedAt: new Date() })
  pushLog(taskId, 'warn', '任务已手动终止')
}

async function getDecryptedCredentials(appId: number, platform: string): Promise<Record<string, string> | null> {
  const db = getDb()
  const row = db
    .select()
    .from(platformCredentials)
    .where(and(eq(platformCredentials.appId, appId), eq(platformCredentials.platform, platform)))
    .get()

  if (!row) return null

  try {
    const buf = Buffer.from(row.encryptedBlob, 'base64')
    const decrypted = safeStorage.decryptString(buf)
    return JSON.parse(decrypted) as Record<string, string>
  } catch {
    return null
  }
}

export async function startUploadTask(taskId: number): Promise<void> {
  if (isTaskCanceled(taskId)) return

  const db = getDb()
  const task = db.select().from(releaseTasks).where(eq(releaseTasks.id, taskId)).get()
  if (!task) throw new Error(`Task ${taskId} not found`)
  const app = db.select().from(apps).where(eq(apps.id, task.appId)).get()

  const creds = await getDecryptedCredentials(task.appId, task.platform)
  if (!creds) {
    pushLog(taskId, 'error', `未找到 ${task.platform} 平台凭证，请先配置`)
    updateTaskStatus(taskId, 'upload_failed')
    return
  }
  if (task.platform === 'yingyongbao' && app?.bundleId && !creds.pkgName) {
    creds.pkgName = app.bundleId
  }

  const svc = getService(task.platform)
  pushLog(taskId, 'info', `开始上传 APK 到 ${svc.displayName}`)
  pushLog(taskId, 'info', `任务详情: taskId=${task.id}, appId=${task.appId}, platform=${task.platform}, apk=${task.apkPath}`)
  updateTaskStatus(taskId, 'uploading')

  let attempt = 0
  while (attempt < 3) {
    if (isTaskCanceled(taskId)) {
      pushLog(taskId, 'warn', '检测到任务已终止，停止上传流程')
      return
    }

    try {
      pushLog(taskId, 'info', `开始第 ${attempt + 1} 次上传尝试`)
      pushLog(taskId, 'info', task.platform === 'yingyongbao' ? '应用宝上传流程：获取上传地址 -> 上传APK -> 提交更新审核' : '正在与平台通信并上传文件，请稍候')

      const heartbeat = setInterval(() => {
        pushLog(taskId, 'info', '上传进行中，请稍候...')
      }, 10000)

      let auditTaskId: string
      try {
        auditTaskId = await svc.upload(
          task.apkPath,
          { versionName: task.versionName, versionCode: task.versionCode, releaseNotes: task.releaseNotes ?? undefined },
          creds
        )
      } finally {
        clearInterval(heartbeat)
      }

      if (isTaskCanceled(taskId)) {
        pushLog(taskId, 'warn', '任务已终止，忽略本次上传结果')
        return
      }

      db.update(releaseTasks).set({ auditTaskId }).where(eq(releaseTasks.id, taskId)).run()
      pushLog(taskId, 'info', `上传成功，审核任务 ID: ${auditTaskId}`)

      if (task.platform === 'yingyongbao') {
        // 应用宝不支持 API 轮询，等待手动确认
        updateTaskStatus(taskId, 'pending_review')
        pushLog(taskId, 'warn', '应用宝不支持 API 轮询审核状态，请在后台确认审核通过后，手动点击"标记审核通过"')
      } else {
        updateTaskStatus(taskId, 'pending_review')
      }
      return
    } catch (err: unknown) {
      attempt++
      pushLog(taskId, 'error', `上传失败 (尝试 ${attempt}/3)`)
      logDetailedError(taskId, '上传失败详情', err)
      if (attempt >= 3) {
        updateTaskStatus(taskId, 'upload_failed')
        return
      }
      // Wait 5s before retry
      await new Promise((r) => setTimeout(r, 5000))
    }
  }
}

export async function pollAuditStatus(taskId: number): Promise<void> {
  if (isTaskCanceled(taskId)) return

  const db = getDb()
  const task = db.select().from(releaseTasks).where(eq(releaseTasks.id, taskId)).get()
  if (!task || !task.auditTaskId) return
  const app = db.select().from(apps).where(eq(apps.id, task.appId)).get()

  const creds = await getDecryptedCredentials(task.appId, task.platform)
  if (!creds) return
  if (task.platform === 'yingyongbao' && app?.bundleId && !creds.pkgName) {
    creds.pkgName = app.bundleId
  }

  const svc = getService(task.platform)

  try {
    const status = await svc.getAuditStatus(task.auditTaskId, creds)
    pushLog(taskId, 'info', `审核状态查询: ${status}`)

    if (status === 'passed') {
      if (task.scheduledPublishAt) {
        updateTaskStatus(taskId, 'scheduled')
        pushLog(taskId, 'info', `审核通过，将在 ${task.scheduledPublishAt.toLocaleString()} 自动上架`)
      } else {
        await triggerPublish(taskId)
      }
    } else if (status === 'failed') {
      updateTaskStatus(taskId, 'audit_failed')
      pushLog(taskId, 'error', '审核被拒绝，请前往平台查看原因')
    }
  } catch (err: unknown) {
    if (err instanceof PlatformNoPollingError) return // yingyongbao — silent
    logDetailedError(taskId, '审核状态查询失败', err)
  }
}

export async function triggerPublish(taskId: number): Promise<void> {
  if (isTaskCanceled(taskId)) return

  const db = getDb()
  const task = db.select().from(releaseTasks).where(eq(releaseTasks.id, taskId)).get()
  if (!task || !task.auditTaskId) return
  const app = db.select().from(apps).where(eq(apps.id, task.appId)).get()

  const creds = await getDecryptedCredentials(task.appId, task.platform)
  if (!creds) {
    updateTaskStatus(taskId, 'publish_failed')
    pushLog(taskId, 'error', '凭证不存在，无法发布')
    return
  }
  if (task.platform === 'yingyongbao' && app?.bundleId && !creds.pkgName) {
    creds.pkgName = app.bundleId
  }

  const svc = getService(task.platform)
  pushLog(taskId, 'info', `开始发布到 ${svc.displayName}`)
  updateTaskStatus(taskId, 'publishing')

  try {
    await svc.publish(task.auditTaskId, creds)
    updateTaskStatus(taskId, 'published', { completedAt: new Date() })
    pushLog(taskId, 'info', '发布成功！')
  } catch (err: unknown) {
    updateTaskStatus(taskId, 'publish_failed')
    logDetailedError(taskId, '发布失败', err)
  }
}

/** Called by UI when user manually confirms audit passed (yingyongbao) */
export function manualConfirmAuditPassed(taskId: number): void {
  if (isTaskCanceled(taskId)) return

  const db = getDb()
  const task = db.select().from(releaseTasks).where(eq(releaseTasks.id, taskId)).get()
  if (!task) return

  if (task.scheduledPublishAt) {
    updateTaskStatus(taskId, 'scheduled')
  } else {
    triggerPublish(taskId).catch(() => {})
  }
}

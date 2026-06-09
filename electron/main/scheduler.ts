import cron from 'node-cron'
import { getDb } from '../db'
import { releaseTasks } from '../db/schema'
import { eq, and, inArray, lte } from 'drizzle-orm'
import { pollAuditStatus, triggerPublish } from './task-manager'

let auditPoller: cron.ScheduledTask | null = null
let publishScheduler: cron.ScheduledTask | null = null

/** Start background cron jobs. Call once after initDb(). */
export function startSchedulers(): void {
  // Poll audit status every 10 minutes
  auditPoller = cron.schedule('*/10 * * * *', async () => {
    const db = getDb()
    const pending = db
      .select({ id: releaseTasks.id })
      .from(releaseTasks)
      .where(eq(releaseTasks.status, 'pending_review'))
      .all()

    for (const task of pending) {
      await pollAuditStatus(task.id).catch(console.error)
    }
  })

  // Check scheduled tasks every minute
  publishScheduler = cron.schedule('* * * * *', async () => {
    const db = getDb()
    const now = new Date()
    const due = db
      .select({ id: releaseTasks.id })
      .from(releaseTasks)
      .where(
        and(
          eq(releaseTasks.status, 'scheduled'),
          lte(releaseTasks.scheduledPublishAt, now)
        )
      )
      .all()

    for (const task of due) {
      await triggerPublish(task.id).catch(console.error)
    }
  })

  console.log('[Scheduler] Audit poller and publish scheduler started')
}

export function stopSchedulers(): void {
  auditPoller?.stop()
  publishScheduler?.stop()
}

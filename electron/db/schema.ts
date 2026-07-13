import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const apps = sqliteTable('apps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  appAlias: text('app_alias'),
  iconPath: text('icon_path'),
  apkRootDir: text('apk_root_dir'),
  bundleId: text('bundle_id').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
})

export const platformCredentials = sqliteTable('platform_credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  appId: integer('app_id')
    .notNull()
    .references(() => apps.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(), // huawei | honor | xiaomi | oppo | vivo | yingyongbao
  encryptedBlob: text('encrypted_blob').notNull(), // Buffer as base64
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
})

export const releaseTasks = sqliteTable('release_tasks', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  appId: integer('app_id')
    .notNull()
    .references(() => apps.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),
  apkPath: text('apk_path').notNull(),
  versionName: text('version_name').notNull(),
  versionCode: integer('version_code').notNull(),
  releaseNotes: text('release_notes'),
  // Status: uploading | upload_failed | pending_review | audit_failed | audit_passed | scheduled | publishing | published | publish_failed
  status: text('status').notNull().default('uploading'),
  auditTaskId: text('audit_task_id'),
  scheduledPublishAt: integer('scheduled_publish_at', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
  completedAt: integer('completed_at', { mode: 'timestamp' })
})

export const taskLogs = sqliteTable('task_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id')
    .notNull()
    .references(() => releaseTasks.id, { onDelete: 'cascade' }),
  level: text('level').notNull().default('info'), // info | error | warn
  message: text('message').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`)
})

export type App = typeof apps.$inferSelect
export type NewApp = typeof apps.$inferInsert
export type PlatformCredential = typeof platformCredentials.$inferSelect
export type ReleaseTask = typeof releaseTasks.$inferSelect
export type NewReleaseTask = typeof releaseTasks.$inferInsert
export type TaskLog = typeof taskLogs.$inferSelect

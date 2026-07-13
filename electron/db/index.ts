import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { join } from 'path'
import { app } from 'electron'
import * as schema from './schema'

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

const DDL = `
CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  app_alias TEXT,
  icon_path TEXT,
  apk_root_dir TEXT,
  bundle_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS platform_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  encrypted_blob TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS release_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id INTEGER NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  apk_path TEXT NOT NULL,
  version_name TEXT NOT NULL,
  version_code INTEGER NOT NULL,
  release_notes TEXT,
  status TEXT NOT NULL DEFAULT 'uploading',
  audit_task_id TEXT,
  scheduled_publish_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  completed_at INTEGER
);

CREATE TABLE IF NOT EXISTS task_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES release_tasks(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`

function getDbPath(): string {
  const userDataPath = app.getPath('userData')
  return join(userDataPath, 'autorelease.sqlite')
}

export function initDb(): void {
  const sqlite = new Database(getDbPath())
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  // Run DDL to ensure all tables exist (idempotent via IF NOT EXISTS)
  sqlite.exec(DDL)
  // Lightweight compatibility migration for older local DBs.
  const columns = sqlite.prepare("PRAGMA table_info('apps')").all() as Array<{ name: string }>
  if (!columns.some((c) => c.name === 'app_alias')) {
    sqlite.exec('ALTER TABLE apps ADD COLUMN app_alias TEXT')
  }
  if (!columns.some((c) => c.name === 'apk_root_dir')) {
    sqlite.exec('ALTER TABLE apps ADD COLUMN apk_root_dir TEXT')
  }

  _db = drizzle(sqlite, { schema })
}

export function getDb(): ReturnType<typeof drizzle<typeof schema>> {
  if (!_db) throw new Error('Database not initialized. Call initDb() first.')
  return _db
}

import { defineConfig } from 'drizzle-kit'
import { join } from 'path'
import { app } from 'electron'

// For drizzle-kit CLI migrations, use a local path
const dbPath = join(process.cwd(), 'dev-database.sqlite')

export default defineConfig({
  schema: './electron/db/schema.ts',
  out: './electron/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: dbPath
  }
})

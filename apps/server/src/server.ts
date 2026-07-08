import path from 'node:path'
import os from 'node:os'
import { mkdir } from 'node:fs/promises'

import express from 'express'

import { detectBrowserBinary } from './core/cdp.js'
import { setWorkspaceRoot } from './core/paths.js'
import { processQueuedSessions } from './pipeline/agent-runner/index.js'
import eventsRouter from './routes/events.js'
import jobsRouter from './routes/jobs.js'
import { sessionStore } from './session-store.js'
import { getBackendConfig } from './config/index.js'

const isExpectedConnectionCloseError = (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  (error.code === 'EPIPE' || error.code === 'ECONNRESET')

process.on('unhandledRejection', (reason) => {
  if (isExpectedConnectionCloseError(reason)) return
  console.error('[fatal] unhandledRejection:', reason)
})

process.on('uncaughtException', (error) => {
  if (isExpectedConnectionCloseError(error)) return
  console.error('[fatal] uncaughtException:', error)
  process.exit(1)
})

const PORT = getBackendConfig().server.port
const WORKSPACE = getBackendConfig().server.workspace
const BUILD_TIME = new Date().toISOString()

// Initialize workspace root
setWorkspaceRoot(WORKSPACE)

const app = express()

const handleHealth = (_req: express.Request, res: express.Response) => {
  res.status(200).type('text/plain').send('ok')
}

// Mount core service routes.
const router = express.Router()

router.all('/health', handleHealth)

router.use(express.json())

// API routes
router.use('/api', jobsRouter)
router.use('/api', eventsRouter)

router.get('/', (_req, res) => {
  res.json({
    name: 'svg-transform-core',
    status: 'ok',
    buildTime: BUILD_TIME,
  })
})

app.use(router)

const main = async () => {
  await mkdir(WORKSPACE, { recursive: true })
  await sessionStore.hydrateFromDisk()
  processQueuedSessions()

  app.listen(PORT, () => {
    const browserBinary = detectBrowserBinary()

    console.log(`SVG transform core service running at http://localhost:${PORT}`)
    console.log(`Workspace: ${WORKSPACE}`)
    console.log(`Platform: ${process.platform} ${os.release()}`)
    console.log(`Node: ${process.version}`)
    console.log(`Browser Binary: ${browserBinary ?? 'NOT FOUND'}`)
    console.log(`Build Time: ${BUILD_TIME}`)
  })
}

main().catch((error) => {
  const browserBinary = detectBrowserBinary()
  const message = error instanceof Error ? error.message : String(error)

  console.error('Failed to start service')
  console.error(`Workspace: ${WORKSPACE}`)
  console.error(`Browser Binary: ${browserBinary ?? 'NOT FOUND'}`)
  console.error(message)
  if (/EACCES|permission denied/i.test(message) && PORT === 80) {
    console.error('Port 80 需要更高权限；请使用 sudo 启动，或改用 PORT 环境变量指定其他端口。')
  }
  process.exitCode = 1
})

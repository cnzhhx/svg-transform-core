import { Router } from 'express'
import { QueueSettingsError, type QueueSettingsStore } from '../core/queue-settings.js'

// Like the job execution API, this is private to the trusted gateway/network.
export function createQueueSettingsRouter(store: QueueSettingsStore, processQueue: () => void) {
  const router = Router()
  router.route('/queue/settings')
    .get(async (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store')
      try { res.json(await store.read()) } catch (error) { next(error) }
    })
    .put(async (req, res, next) => {
      res.setHeader('Cache-Control', 'no-store')
      try { res.json(await store.save(req.body, processQueue)) }
      catch (error) {
        if (error instanceof QueueSettingsError) res.status(error.status).json({ error: error.message })
        else next(error)
      }
    })
  return router
}

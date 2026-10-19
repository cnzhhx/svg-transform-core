import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import express from 'express'
import { QueueSettingsStore } from '../../src/core/queue-settings.js'
import { createQueueSettingsRouter } from '../../src/routes/queue-settings.js'
import { createAgentRunQueue } from '../../src/pipeline/agent-runner/queue/run-queue.js'
import { sessionStore } from '../../src/session-store.js'

test('queue API increases live capacity and drains excess sessions on decrease without cancellation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'core-queue-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  t.mock.method(sessionStore, 'list', () => [])
  t.mock.method(sessionStore, 'markQueued', () => {})
  t.mock.method(sessionStore, 'flushSessionWrites', async () => {})
  t.mock.method(sessionStore, 'get', (id: string) => ({ id, pendingUserMessages: [], status: 'running' }) as unknown as ReturnType<typeof sessionStore.get>)
  t.mock.method(sessionStore, 'updateQueuePosition', () => {})
  const settings = new QueueSettingsStore(path.join(dir, 'queue-settings.json'), 1)
  const started: string[] = []
  const finishes = new Map<string, () => void>()
  const controllers: AbortController[] = []
  const queue = createAgentRunQueue({ maxConcurrentAgents: () => settings.limit, runSession: (id, controller) => {
    started.push(id); controllers.push(controller)
    return new Promise<void>(resolve => finishes.set(id, resolve))
  } })
  const app = express(); app.use(express.json()); app.use('/api', createQueueSettingsRouter(settings, queue.processQueuedSessions))
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const address = server.address(); assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}/api/queue/settings`
  const save = (revision: number, maxConcurrentJobs: unknown) => fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, maxConcurrentJobs }) })
  for (const id of ['a', 'b', 'c', 'd']) await queue.enqueueSession(id)
  assert.deepEqual(started, ['a'])
  assert.equal((await save(1, 3)).status, 200)
  assert.deepEqual(started, ['a', 'b', 'c'])
  assert.equal((await save(1, 2)).status, 409)
  assert.equal((await save(2, 0)).status, 400)
  assert.equal((await save(2, 1)).status, 200)
  assert.ok(controllers.every(controller => !controller.signal.aborted))
  finishes.get('a')!(); await setImmediate()
  finishes.get('b')!(); await setImmediate()
  assert.deepEqual(started, ['a', 'b', 'c'])
  finishes.get('c')!(); await setImmediate()
  assert.deepEqual(started, ['a', 'b', 'c', 'd'])
  finishes.get('d')!(); await setImmediate()
  assert.deepEqual(await (await fetch(url)).json(), { revision: 3, maxConcurrentJobs: 1 })
  const restarted = new QueueSettingsStore(path.join(dir, 'queue-settings.json'), 8)
  assert.deepEqual(await restarted.read(), { revision: 3, maxConcurrentJobs: 1 })
})

test('atomic settings reject conflicting saves, preserve failed writes and reject corrupt persisted data', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'core-queue-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'queue-settings.json')
  const store = new QueueSettingsStore(file, 1)
  const results = await Promise.allSettled([store.save({ revision: 1, maxConcurrentJobs: 2 }), store.save({ revision: 1, maxConcurrentJobs: 3 })])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  const before = await readFile(file, 'utf8')
  const broken = new QueueSettingsStore(file, 1, async () => { throw Error('disk full') })
  await assert.rejects(broken.save({ revision: 2, maxConcurrentJobs: 4 }), /disk full/)
  assert.equal(broken.limit, 2)
  assert.equal(await readFile(file, 'utf8'), before)
  for (const maxConcurrentJobs of [0, 33, 1.5, '2', null]) await assert.rejects(store.save({ revision: 2, maxConcurrentJobs }))
  await writeFile(file, 'broken')
  await assert.rejects(new QueueSettingsStore(file, 1).initialize())
})

import { sessionStore } from '../../../session-store.js'

type RunSession = (
  sessionId: string,
  controller: AbortController,
) => Promise<void>

type MaxConcurrentAgentsInput = number | (() => number)

const createAgentRunQueue = ({
  maxConcurrentAgents,
  runSession,
}: {
  maxConcurrentAgents: MaxConcurrentAgentsInput
  runSession: RunSession
}) => {
  const queue: string[] = []
  const queued = new Set<string>()
  const accepting = new Set<string>()
  let stopping = false
  const activeRuns = new Map<
    string,
    {
      controller: AbortController
      finished: Promise<void>
      resolveFinished: () => void
    }
  >()

  const reserveRunSlot = (sessionId: string) => {
    const existing = activeRuns.get(sessionId)
    if (existing) return existing
    const controller = new AbortController()
    let resolveFinished = () => {}
    const finished = new Promise<void>((resolve) => {
      resolveFinished = resolve
    })
    const runState = { controller, finished, resolveFinished }
    activeRuns.set(sessionId, runState)
    return runState
  }

  const getMaxConcurrentAgents = () =>
    Math.max(
      1,
      Math.floor(
        typeof maxConcurrentAgents === 'function'
          ? maxConcurrentAgents()
          : maxConcurrentAgents,
      ),
    )

  const broadcastQueuePositions = () => {
    for (let i = 0; i < queue.length; i++) {
      const sid = queue[i]!
      const position = i + 1
      sessionStore.updateQueuePosition(sid, position, queue.length)
    }
  }

  const refillQueueFromStore = () => {
    const queuedSessions = sessionStore
      .list()
      .filter(
        (session) =>
          session.status === 'queued' &&
          !queued.has(session.id) &&
          !accepting.has(session.id) &&
          !activeRuns.has(session.id),
      )
      .sort((left, right) => {
        const leftQueuedAt = left.queuedAt ?? left.createdAt
        const rightQueuedAt = right.queuedAt ?? right.createdAt
        if (leftQueuedAt !== rightQueuedAt) return leftQueuedAt - rightQueuedAt
        return left.createdAt - right.createdAt
      })

    for (const session of queuedSessions) {
      queue.push(session.id)
      queued.add(session.id)
    }
  }

  const processQueue = () => {
    if (stopping) return
    refillQueueFromStore()
    while (activeRuns.size < getMaxConcurrentAgents() && queue.length > 0) {
      const sessionId = queue.shift()!
      queued.delete(sessionId)
      const activeRun = reserveRunSlot(sessionId)
      void runSession(sessionId, activeRun.controller)
        .catch((error) => {
          console.error(`[agent-runner] runSession(${sessionId}) uncaught:`, error)
          const message = error instanceof Error ? error.message : String(error)
          sessionStore.failPipeline(sessionId, message)
        })
        .finally(() => {
          activeRun.resolveFinished()
          activeRuns.delete(sessionId)
          const current = sessionStore.get(sessionId)
          if (!stopping && current?.pendingUserMessages.length && current.status !== 'failed') {
            void enqueueSession(sessionId).catch((error) => console.error('[queue] pending guidance:', error))
          }
          processQueue()
        })
    }
    broadcastQueuePositions()
  }

  const processQueuedSessions = () => {
    processQueue()
  }

  const enqueueSession = async (sessionId: string) => {
    if (stopping) throw new Error('Service is shutting down')
    if (queued.has(sessionId) || activeRuns.has(sessionId) || accepting.has(sessionId)) return
    accepting.add(sessionId)
    try {
      sessionStore.markQueued(sessionId)
      await sessionStore.flushSessionWrites(sessionId)
      if (!sessionStore.get(sessionId)) return
      queue.push(sessionId)
      queued.add(sessionId)
    } catch (error) {
      sessionStore.failPipeline(sessionId, `Unable to persist queued job: ${String(error)}`)
      throw error
    } finally { accepting.delete(sessionId) }
    processQueue()
  }

  const removeFromQueue = (sessionId: string) => {
    const index = queue.indexOf(sessionId)
    const removed = index >= 0
    if (removed) queue.splice(index, 1)
    queued.delete(sessionId)
    broadcastQueuePositions()
    return removed
  }

  const cancelSessionRun = (sessionId: string) => {
    const removedQueued = removeFromQueue(sessionId)
    const active = activeRuns.get(sessionId)
    if (!active) return { active: false as const, queued: removedQueued }
    sessionStore.addLog(sessionId, '[agent] session delete requested; canceling run')
    active.controller.abort('deleted-by-user')
    return { active: true as const, finished: active.finished, queued: false }
  }

  return {
    async shutdown() {
      stopping = true
      const running = [...activeRuns.entries()]
      running.forEach(([, state]) => state.controller.abort('service-shutdown'))
      await Promise.all(running.map(([, state]) => state.finished))
      for (const [id] of running) {
        const session = sessionStore.get(id)
        if (session && !['completed', 'best-effort', 'failed-gate'].includes(session.status)) {
          session.status = 'failed'
          sessionStore.markQueued(id)
        }
      }
      await sessionStore.flushAll()
    },
    cancelSessionRun,
    enqueueSession,
    processQueuedSessions,
  }
}

export { createAgentRunQueue }

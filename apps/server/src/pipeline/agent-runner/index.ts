import { getMaxConcurrentAgents } from '../../config/index.js'
import path from 'node:path'
import { getWorkspaceRoot } from '../../core/paths.js'
import { QueueSettingsStore } from '../../core/queue-settings.js'
import { createAgentRunQueue } from './queue/run-queue.js'
import { runSession } from './session/session-runner.js'

export const queueSettings = new QueueSettingsStore(path.join(getWorkspaceRoot(), 'queue-settings.json'), getMaxConcurrentAgents())

const agentRunQueue = createAgentRunQueue({
  maxConcurrentAgents: () => queueSettings.limit,
  runSession,
})

const { cancelSessionRun, enqueueSession, processQueuedSessions, shutdown: shutdownAgentQueue } = agentRunQueue

export { cancelSessionRun, enqueueSession, processQueuedSessions, shutdownAgentQueue }

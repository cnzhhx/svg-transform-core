import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export type QueueSettings = { revision: number; maxConcurrentJobs: number }
export class QueueSettingsError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

export function validateQueueSettings(value: unknown): QueueSettings {
  const data = value as QueueSettings | null
  if (!data || !Number.isSafeInteger(data.revision) || data.revision < 1 ||
    !Number.isInteger(data.maxConcurrentJobs) || data.maxConcurrentJobs < 1 || data.maxConcurrentJobs > 32) {
    throw new QueueSettingsError(400, '同时执行的 session 数必须是 1–32 的整数，且需提供有效的设置版本')
  }
  return { revision: data.revision, maxConcurrentJobs: data.maxConcurrentJobs }
}

// One scheduler owns one workspace. Publish the new limit only after the atomic
// disk write succeeds, so failed saves cannot silently change live execution.
export class QueueSettingsStore {
  private state: QueueSettings
  private initialized?: Promise<void>
  private pending: Promise<unknown> = Promise.resolve()
  constructor(private readonly file: string, defaultLimit: number, private readonly write = writeFile) {
    this.state = { revision: 1, maxConcurrentJobs: defaultLimit }
  }
  get limit() { return this.state.maxConcurrentJobs }
  initialize() {
    return this.initialized ??= (async () => {
      try { this.state = validateQueueSettings(JSON.parse(await readFile(this.file, 'utf8'))) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    })()
  }
  async read() { await this.initialize(); return { ...this.state } }
  save(value: unknown, applied: () => void = () => {}) {
    const operation = this.pending.then(async () => {
      await this.initialize()
      const next = validateQueueSettings(value)
      if (next.revision !== this.state.revision) throw new QueueSettingsError(409, '并发设置已更新，请重新加载后再保存')
      next.revision++
      await mkdir(path.dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${randomUUID()}.tmp`
      try {
        await this.write(temporary, JSON.stringify(next) + '\n', { mode: 0o600 })
        await rename(temporary, this.file)
      } finally { await unlink(temporary).catch(() => {}) }
      this.state = next
      applied()
      return { ...next }
    })
    this.pending = operation.catch(() => {})
    return operation
  }
}

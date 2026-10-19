const throwIfAbortedSignal = (signal?: AbortSignal) => {
  if (!signal?.aborted) return
  const error = new Error(
    typeof signal.reason === 'string' ? signal.reason : 'aborted',
  )
  error.name = 'AbortError'
  throw error
}

/**
 * A shared concurrency limiter. Multiple callers across different async flows
 * can call `run()` concurrently; at most `limit` functions execute simultaneously.
 */
class Semaphore {
  private active = 0
  private readonly queue: Array<() => void> = []

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer')
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      throwIfAbortedSignal(signal)
      return await fn()
    } finally {
      this.release()
    }
  }

  async lease(signal?: AbortSignal): Promise<() => void> {
    await this.acquire(signal)
    let released = false
    return () => { if (!released) { released = true; this.release() } }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    throwIfAbortedSignal(signal)
    if (this.active < this.limit) {
      this.active++
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      const abort = () => {
        const index = this.queue.indexOf(next)
        if (index >= 0) this.queue.splice(index, 1)
        try { throwIfAbortedSignal(signal) } catch (error) { reject(error) }
      }
      const next = () => {
        signal?.removeEventListener('abort', abort)
        this.active++
        resolve()
      }
      this.queue.push(next)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }

  private release(): void {
    this.active--
    const next = this.queue.shift()
    if (next) next()
  }
}

const runWithLimit = async <T, R>({
  items,
  limit,
  signal,
  worker,
  cancelOnError,
}: {
  items: T[]
  limit: number
  signal?: AbortSignal
  worker: (item: T, index: number) => Promise<R>
  cancelOnError?: (error: unknown) => void
}) => {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency must be a positive integer')
  const results: R[] = []
  let cursor = 0
  let failed = false
  let firstError: unknown

  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      try {
        while (!failed && cursor < items.length) {
          throwIfAbortedSignal(signal)
          const index = cursor
          cursor += 1
          results[index] = await worker(items[index]!, index)
        }
      } catch (error) {
        if (!failed) {
          failed = true
          firstError = error
          cancelOnError?.(error)
        }
      }
    },
  )

  await Promise.allSettled(workers)
  if (failed) throw firstError
  throwIfAbortedSignal(signal)
  return results
}

export { runWithLimit, Semaphore }

import { Semaphore } from '../pipeline/agent-runner/queue/concurrency.js';

type ResourceKind = 'model' | 'vision' | 'build' | 'reference';
const pools = new Map<ResourceKind, Semaphore>();
const defaults: Record<ResourceKind, number> = { model: 10, vision: 3, build: 2, reference: 1 };
export const resourcePool = (kind: ResourceKind) => {
  let pool = pools.get(kind);
  if (!pool) {
    const configured = process.env[`GLOBAL_${kind.toUpperCase()}_CONCURRENCY`] ??
      (kind === 'vision' ? process.env['SEMANTIC_VISION_CONCURRENCY'] : undefined);
    const limit = configured === undefined ? defaults[kind] : Number(configured);
    if (!Number.isInteger(limit) || limit < 1 || limit > 128) throw new Error(`Invalid global ${kind} concurrency`);
    pool = new Semaphore(limit);
    pools.set(kind, pool);
  }
  return pool;
};

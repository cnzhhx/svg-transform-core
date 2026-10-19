import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jobsRouter from '../../src/routes/jobs.js';
import eventsRouter from '../../src/routes/events.js';
import { sessionStore } from '../../src/session-store.js';
import { getWorkspaceRoot, setWorkspaceRoot } from '../../src/core/paths.js';

test('HTTP uploads are validated and durable, SSE initializes and deletes, file serving rejects escaping symlinks', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'job-api-'));
  const previous = getWorkspaceRoot();
  const previousConfig = process.env['MODEL_PROVIDER_CONFIG'];
  setWorkspaceRoot(root);
  const config = path.join(root, 'provider.json');
  await writeFile(config, JSON.stringify({ models: { test: { model: 'test', provider: 'test' } } }));
  process.env['MODEL_PROVIDER_CONFIG'] = config;
  const app = express();
  app.use(express.json()); app.use('/api', jobsRouter); app.use('/api', eventsRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const base = `http://127.0.0.1:${address.port}`;
  const controller = new AbortController();
  let id: string | undefined;
  try {
    const upload = async (svg: string) => {
      const form = new FormData(); form.append('svg', new Blob([svg]), 'test.svg'); form.append('dryRun', '1');
      return fetch(`${base}/api/jobs`, { method: 'POST', body: form });
    };
    assert.equal((await upload('<not-svg/>')).status, 400);
    const response = await upload('<svg xmlns="http://www.w3.org/2000/svg" width="1in" height="1in"/>');
    assert.equal(response.status, 202);
    const job = await response.json() as { jobId: string; status: string };
    id = job.jobId;
    assert.equal(job.status, 'draft');
    const snapshot = JSON.parse(await readFile(path.join(root, 'jobs', id, 'session.json'), 'utf8'));
    assert.equal(snapshot.status, 'draft');
    assert.equal((await fetch(`${base}/api/jobs/${id}/download`)).status, 409);
    await symlink(config, path.join(root, 'jobs', id, 'outside.json'));
    assert.equal((await fetch(`${base}/api/jobs/${id}/files/outside.json`)).status, 403);
    const stream = await fetch(`${base}/api/jobs/${id}/events`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    const initial = decoder.decode((await reader.read()).value);
    assert.match(initial, /"type":"init"/);
    assert.equal((await fetch(`${base}/api/jobs/${id}`, { method: 'DELETE' })).status, 200);
    let final = '';
    for (;;) { const next = await reader.read(); if (next.done) break; final += decoder.decode(next.value); }
    assert.match(final, /"type":"job:deleted"/);
    assert.equal(sessionStore.get(id), undefined);
  } finally {
    controller.abort(); server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    if (id && sessionStore.get(id)) await sessionStore.deleteSession(id);
    await sessionStore.flushAll();
    if (previousConfig === undefined) delete process.env['MODEL_PROVIDER_CONFIG']; else process.env['MODEL_PROVIDER_CONFIG'] = previousConfig;
    setWorkspaceRoot(previous); await rm(root, { recursive: true, force: true });
  }
});

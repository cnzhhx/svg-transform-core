import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareDeliverable } from '../../src/pipeline/deliverables.js';
import { resolveOutputTarget } from '../../src/core/output-target.js';
import { buildFrameworkProject } from '../../src/core/framework-build.js';
import type { Session } from '../../src/session-store.js';

const exec = promisify(execFile);

for (const format of ['html', 'react', 'vue', 'flutter'] as const) {
  test(`${format} deliverables contain portable source, assets, quality and an immutable manifest`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), `deliverable-${format}-`));
    const relocated = await mkdtemp(path.join(os.tmpdir(), `exported-${format}-`));
    try {
      const svgPath = path.join(root, 'design.svg');
      const target = resolveOutputTarget({ svgPath, format });
      await mkdir(path.dirname(target.sourceEntryPath), { recursive: true });
      await mkdir(path.join(root, 'assets'));
      await writeFile(path.join(root, 'assets', 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2"/></svg>');
      const image = '<img src="./assets/icon.svg" alt="icon"/>';
      await writeFile(target.renderEntryPath, `<html><body>${image}</body></html>`);
      if (format === 'react') {
        await writeFile(target.sourceEntryPath, `export default function App(){return <main>${image}</main>}`);
        await writeFile(target.sourceStylePath!, 'body { margin: 0; }');
      } else if (format === 'vue') await writeFile(target.sourceEntryPath, `<template><main>${image}</main></template>`);
      else if (format === 'flutter') {
        await writeFile(target.sourceEntryPath, 'void main() {}');
        await writeFile(path.join(target.frameworkProjectDir!, 'pubspec.yaml'), 'name: test_app');
        await mkdir(target.frameworkBuildDir!, { recursive: true });
        await writeFile(path.join(target.frameworkBuildDir!, 'index.html'), '<html>Built Flutter fixture</html>');
      }
      await writeFile(path.join(root, 'events.jsonl'), 'private diagnostic');
      const job = { sessionDir: root, outputTarget: target, outputFormat: format,
        result: { designWidth: 120, designHeight: 80, quality: { status: 'pass', softIssues: [], blockingIssues: [], gateSummary: {} } } } satisfies Pick<Session, 'sessionDir' | 'outputTarget' | 'outputFormat' | 'result'>;
      const output = await prepareDeliverable(job);
      const dir = path.dirname(output.manifestPath);
      const manifest = JSON.parse(await readFile(output.manifestPath, 'utf8'));
      assert.ok(manifest.files.some((file: { path: string }) => file.path === 'assets/icon.svg'));
      assert.ok(!manifest.files.some((file: { path: string }) => file.path === 'events.jsonl'));
      assert.ok((await readFile(output.zipPath)).length > 100);
      await cp(dir, relocated, { recursive: true });
      await writeFile(target.renderEntryPath, 'changed after export');
      assert.match(await readFile(path.join(relocated, 'design.html'), 'utf8'), /icon.svg/);
      if (format === 'react' || format === 'vue') {
        const mainSource = await readFile(path.join(relocated, 'src', format === 'vue' ? 'main.ts' : 'main.tsx'), 'utf8');
        assert.ok(!mainSource.includes(path.basename(root)), 'entry must not import the original workspace');
        if (process.env['TEST_EXPORTED_INSTALL'] === '1') {
          await exec('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: relocated, timeout: 180_000 });
          await exec('npm', ['run', 'build'], { cwd: relocated, timeout: 60_000 });
        } else {
          await buildFrameworkProject({ entryDir: relocated, distDir: path.join(relocated, 'dist'), format });
        }
        assert.match(await readFile(path.join(relocated, 'dist/index.html'), 'utf8'), /script/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(relocated, { recursive: true, force: true });
    }
  });
}

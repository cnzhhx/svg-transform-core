import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, realpath, stat, copyFile, rm, rename } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import path from 'node:path';
import archiver from 'archiver';
import { getWorkspaceRoot, isInsidePath } from '../core/paths.js';
import { writeJsonFile, writeTextFile } from '../core/file-io.js';
import { writeFrameworkEntryFiles } from '../core/framework-build.js';
import type { Session } from '../session-store.js';

const textExtensions = /\.(html?|css|jsx?|tsx?|vue|json|svg)$/i;
const referencedFiles = (content: string) => [
  ...[...content.matchAll(/["'`]([^"'`\n<>]+\.(?:png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf|css|js|mjs|json|wasm)(?:[?#][^"'`\s]*)?)["'`]/gi)].map((match) => match[1]!),
  ...[...content.matchAll(/url\(\s*["']?([^\s)"']+)/gi)].map((match) => match[1]!),
];

export const prepareDeliverable = async (job: Pick<Session, 'sessionDir' | 'outputTarget' | 'outputFormat' | 'result'>) => {
  const version = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const exportRoot = path.join(job.sessionDir, 'exports');
  const staging = path.join(exportRoot, `.staging-${version}`);
  const finalDir = path.join(exportRoot, version);
  const jobRoot = await realpath(job.sessionDir);
  const copied = new Set<string>();
  const externalReferences = new Set<string>();
  await mkdir(staging, { recursive: true });
  const copy = async (source: string): Promise<void> => {
    const resolved = await realpath(source);
    if (!isInsidePath(jobRoot, resolved)) throw new Error('Deliverable reference escapes job directory');
    if (copied.has(resolved)) return;
    const info = await stat(resolved);
    if (info.isDirectory()) {
      for (const item of await readdir(resolved)) {
        if (item.startsWith('.') || ['build', 'node_modules'].includes(item)) continue;
        await copy(path.join(resolved, item));
      }
      return;
    }
    copied.add(resolved);
    const relative = path.relative(jobRoot, resolved);
    const destination = path.join(staging, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    if (!textExtensions.test(resolved)) { await copyFile(resolved, destination); return; }
    let content = await readFile(resolved, 'utf8');
    for (const ref of new Set(referencedFiles(content))) {
      if (/^(?:https?:|\/\/)/i.test(ref)) { externalReferences.add(ref); continue; }
      if (/^(?:data:|blob:|#)/i.test(ref)) continue;
      const clean = decodeURIComponent(ref.split(/[?#]/)[0]!);
      const dependency = clean.startsWith('/__workspace/')
        ? path.join(getWorkspaceRoot(), clean.slice('/__workspace/'.length))
        : clean.startsWith('/') ? path.resolve(process.cwd(), `.${clean}`)
          : path.resolve(path.dirname(resolved), clean);
      if (!(await stat(dependency).then(() => true, () => false))) continue;
      await copy(dependency);
      if (clean.startsWith('/')) {
        let next = path.relative(path.dirname(resolved), dependency).replaceAll(path.sep, '/');
        if (!next.startsWith('.')) next = `./${next}`;
        content = content.split(ref).join(next + ref.slice(ref.split(/[?#]/)[0]!.length));
      }
    }
    await writeTextFile(destination, content);
  };
  try {
    const target = job.outputTarget;
    await copy(target.sourceEntryPath);
    if (target.sourceStylePath) await copy(target.sourceStylePath);
    await copy(target.renderEntryPath);
    if (job.outputFormat === 'flutter') {
      if (target.frameworkProjectDir) await copy(target.frameworkProjectDir);
      if (target.frameworkBuildDir) await copy(target.frameworkBuildDir);
    } else if (job.outputFormat === 'vue' || job.outputFormat === 'react') {
      const sourceEntryPath = path.join(staging, path.relative(jobRoot, await realpath(target.sourceEntryPath)));
      const sourceStylePath = target.sourceStylePath ? path.join(staging, path.relative(jobRoot, await realpath(target.sourceStylePath))) : undefined;
      await writeFrameworkEntryFiles({ designName: 'Generated design', entryDir: staging,
        format: job.outputFormat, height: job.result.designHeight ?? 1024, width: job.result.designWidth ?? 1024,
        sourceEntryPath, sourceStylePath, srcDir: path.join(staging, 'src') });
      const dependencies = job.outputFormat === 'vue' ? { vue: '3.5.42' } : { react: '19.2.7', 'react-dom': '19.2.7' };
      await writeJsonFile(path.join(staging, 'package.json'), {
        name: 'generated-design', version: '1.0.0', private: true, type: 'module',
        scripts: { dev: 'vite --host 127.0.0.1', build: 'vite build', preview: 'vite preview' },
        dependencies, devDependencies: { vite: '8.2.2', [job.outputFormat === 'vue' ? '@vitejs/plugin-vue' : '@vitejs/plugin-react']: job.outputFormat === 'vue' ? '6.0.7' : '6.0.2', typescript: '5.9.3' },
      });
      await writeTextFile(path.join(staging, 'vite.config.js'), `import { defineConfig } from 'vite';\nimport plugin from '${job.outputFormat === 'vue' ? '@vitejs/plugin-vue' : '@vitejs/plugin-react'}';\nexport default defineConfig({ base: './', plugins: [plugin()] });\n`);
      // Source-data asset strings resolve at document runtime, so publish them as static assets too.
      for (const file of copied) {
        if (!/\.(png|jpe?g|gif|webp|avif|svg|woff2?|ttf|otf)$/i.test(file)) continue;
        const relative = path.relative(jobRoot, file);
        const destination = path.join(staging, 'public', relative);
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(path.join(staging, relative), destination);
      }
    }
    await writeJsonFile(path.join(staging, 'quality.json'), { quality: job.result.quality,
      moduleValidation: job.result.moduleValidationRuns, diffRatio: job.result.diffRatio });
    const entry = path.relative(jobRoot, await realpath(target.renderEntryPath)).replaceAll(path.sep, '/');
    await writeTextFile(path.join(staging, 'README.md'), `# Generated design\n\nFormat: ${job.outputFormat}.\n\nStatic preview: serve this directory with a static HTTP server and open ${entry}.\n\n${job.outputFormat === 'react' || job.outputFormat === 'vue' ? 'Editable project: use Node 22.16+, run npm install, then npm run dev or npm run build.' : job.outputFormat === 'flutter' ? `Flutter project: ${path.basename(target.frameworkProjectDir!)}. With a compatible Flutter SDK, run flutter pub get and flutter run -d chrome there.` : 'The HTML and its referenced assets can be hosted together.'}\n\nQuality diagnostics are in quality.json. External network references, if present, are listed in manifest.json.\n`);
    const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
    const enumerate = async (dir: string) => {
      for (const item of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, item.name);
        if (item.isDirectory()) await enumerate(file);
        else {
          const data = await readFile(file);
          entries.push({ path: path.relative(staging, file).replaceAll(path.sep, '/'), bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') });
        }
      }
    };
    await enumerate(staging);
    await writeJsonFile(path.join(staging, 'manifest.json'), { version, format: job.outputFormat, entry, files: entries.sort((a, b) => a.path.localeCompare(b.path)), externalReferences: [...externalReferences] });
    await rename(staging, finalDir);
    const zipPath = path.join(exportRoot, `${version}.zip`);
    const archive = archiver('zip', { zlib: { level: 6 } });
    const output = createWriteStream(`${zipPath}.tmp`);
    const done = finished(output);
    archive.on('error', (error) => output.destroy(error));
    archive.pipe(output);
    archive.directory(finalDir, false);
    await Promise.all([archive.finalize(), done]);
    await rename(`${zipPath}.tmp`, zipPath);
    return { zipPath, manifestPath: path.join(finalDir, 'manifest.json'), version };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
};

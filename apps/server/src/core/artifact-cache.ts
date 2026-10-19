import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { getBackendConfig } from '../config/backend.js';
import { writeJsonFile } from './file-io.js';
import { fileURLToPath } from 'node:url';
import { CONVERSION_CACHE_VERSION } from './conversion-version.js';

export const fingerprintFiles = async (files: string[], context: unknown = {}) => {
  const hash = createHash('sha256').update(JSON.stringify(context));
  for (const file of [...new Set(files)].sort()) {
    hash.update(file);
    try { hash.update(await readFile(file)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hash.update('<missing>');
    }
  }
  return hash.digest('hex');
};

// Generated previews, traces and verification output are never inputs.
export const moduleInputFiles = async (root: string): Promise<string[]> => {
  const files: string[] = [];
  const visit = async (dir: string) => {
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.name.startsWith('.') || /^(verify|node_modules|runtime-traces|planner-history)$/.test(item.name)) continue;
      const file = path.join(dir, item.name);
      if (item.isSymbolicLink()) throw new Error(`Symbolic links are not supported in module inputs: ${item.name}`);
      if (item.isDirectory()) await visit(file);
      else if (item.isFile() && !/^module-(preview|source)-round-/.test(item.name) &&
        /\.(svg|png|jpe?g|webp|avif|gif|woff2?|ttf|otf|css|jsx|tsx|dart|html|json)$/.test(item.name)) files.push(file);
    }
  };
  await visit(root);
  return files;
};

export const moduleFingerprint = async (root: string, extras: string[] = [], context: unknown = {}) =>
  fingerprintFiles([...await moduleInputFiles(root), ...extras,
    fileURLToPath(new URL('../../package.json', import.meta.url))], {
    version: CONVERSION_CACHE_VERSION, context, diff: getBackendConfig().diff,
    browser: getBackendConfig().browser, node: process.version,
  });

export const atomicJson = async (file: string, value: unknown) => {
  await writeJsonFile(file, value);
};

export const candidateContext = (moduleDir: string, format: string) =>
  fingerprintFiles([path.join(moduleDir, 'module.svg'), path.join(moduleDir, 'module-reference.png'),
    path.join(moduleDir, 'composite.png'), path.join(moduleDir, 'shared-underlay.png')],
    { format, version: CONVERSION_CACHE_VERSION, raster: getBackendConfig().diff.pngRasterScaleMultiplier });

export const readCache = async <T>(file: string): Promise<T | undefined> => {
  try { return JSON.parse(await readFile(file, 'utf8')) as T; } catch { return undefined; }
};

type CachedResult = { diffRatio: number; passed?: boolean; buildError?: string; renderPngPath?: string; svgPngPath?: string; diffPngPath?: string };
export const cachedModuleVerification = async <T extends CachedResult | null>(options: {
  moduleDir: string; kind: string; extras?: string[]; context: unknown;
  signal?: AbortSignal; run: () => Promise<T>; onProgress?: (message: string) => void;
}): Promise<T> => {
  options.signal?.throwIfAborted();
  const file = path.join(options.moduleDir, `.verify-cache-${options.kind}.json`);
  const signature = await moduleFingerprint(options.moduleDir, options.extras, options.context);
  const cached = await readCache<{ signature: string; result: T }>(file);
  if (process.env['VERIFY_CACHE_DISABLED'] !== '1' && cached?.signature === signature && cached.result) {
    const outputs = [cached.result.renderPngPath, cached.result.svgPngPath, cached.result.diffPngPath];
    if (outputs.every(Boolean) && (await Promise.all(outputs.map((output) => stat(output!).then(() => true, () => false)))).every(Boolean)) {
      options.onProgress?.('Verification cache hit: source, assets and render configuration unchanged.');
      return cached.result;
    }
  }
  const result = await options.run();
  options.signal?.throwIfAborted();
  if (result && !result.buildError && await moduleFingerprint(options.moduleDir, options.extras, options.context) === signature) {
    await atomicJson(file, { signature, result });
  }
  return result;
};

type Candidate = { diffRatio: number; files: string[]; context: string };
export const saveModuleCandidate = async (moduleDir: string, diffRatio: number, context: string) => {
  if (!Number.isFinite(diffRatio)) return;
  const root = path.join(moduleDir, '.best-candidate');
  const previous = await readCache<Candidate>(path.join(root, 'candidate.json'));
  if (previous?.context === context && previous.diffRatio <= diffRatio) return;
  const files = await moduleInputFiles(moduleDir);
  const staging = path.join(moduleDir, `.candidate-${crypto.randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    for (const file of files) {
      const target = path.join(staging, path.relative(moduleDir, file));
      await mkdir(path.dirname(target), { recursive: true });
      await cp(file, target);
    }
    await atomicJson(path.join(staging, 'candidate.json'), { diffRatio, context, files: files.map((file) => path.relative(moduleDir, file)) });
    // Keep the previous candidate until the complete replacement exists.
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
  } finally { await rm(staging, { recursive: true, force: true }); }
};

export const restoreModuleCandidate = async (moduleDir: string, currentDiff: number, context: string) => {
  const root = path.join(moduleDir, '.best-candidate');
  const candidate = await readCache<Candidate>(path.join(root, 'candidate.json'));
  if (!candidate || candidate.context !== context || candidate.diffRatio >= currentDiff) return false;
  for (const relative of candidate.files) {
    const target = path.resolve(moduleDir, relative);
    if (!target.startsWith(`${path.resolve(moduleDir)}${path.sep}`)) throw new Error('Invalid candidate path');
    await mkdir(path.dirname(target), { recursive: true });
    await cp(path.join(root, relative), target);
  }
  return true;
};

import path from 'node:path';
import { getBackendConfig } from '../../../config/backend.js';
import { atomicJson, moduleFingerprint, readCache } from '../../../core/artifact-cache.js';

type CheckpointInput = { moduleDir: string; model: string; format: string; scale: number; modulePlanPath: string; scaffoldHtmlPath: string };
const signature = (input: CheckpointInput) => moduleFingerprint(input.moduleDir,
  [input.modulePlanPath, input.scaffoldHtmlPath, getBackendConfig().modelProvider.configPath], { model: input.model, format: input.format, scale: input.scale });
export const saveModuleCheckpoint = async (input: CheckpointInput) => {
  await atomicJson(path.join(input.moduleDir, '.completed-module.json'), { signature: await signature(input) });
};
export const hasValidModuleCheckpoint = async (input: CheckpointInput) => {
  const saved = await readCache<{ signature: string }>(path.join(input.moduleDir, '.completed-module.json'));
  return Boolean(saved && saved.signature === await signature(input));
};

import { access, constants } from 'node:fs/promises';
import path from 'node:path';
import { detectBrowserBinary } from './cdp.js';
import { getBackendConfig } from '../config/backend.js';
import { resolveModelConfigForRole } from '../config/model-provider.js';
import type { OutputFormat } from './output-target.js';
import { resourcePool } from './resources.js';

export const executableAvailable = async (binary: string) => {
  const candidates = path.isAbsolute(binary) || binary.includes(path.sep) ? [binary]
    : (process.env['PATH'] ?? '').split(path.delimiter).map((dir) => path.join(dir, binary));
  return (await Promise.all(candidates.map((file) => access(file, constants.X_OK).then(() => true, () => false)))).some(Boolean);
};

export const checkReadiness = async (format: OutputFormat = 'html', model?: string) => {
  const config = getBackendConfig();
  let modelReady = false;
  try { resolveModelConfigForRole('moduleAgent', model); modelReady = true; } catch { /* Do not expose credentials or provider configuration. */ }
  const browser = detectBrowserBinary();
  const checks = {
    workspace: await access(config.server.workspace, constants.W_OK).then(() => true, () => false),
    browser: Boolean(browser && await executableAvailable(browser)),
    agentRuntime: await executableAvailable(config.runtime.opencodeCliPath),
    model: modelReady,
    configuration: true,
  };
  try {
    for (const kind of ['model', 'vision', 'build', 'reference'] as const) resourcePool(kind);
    if (!['report', 'best-effort', 'strict'].includes(process.env['QUALITY_POLICY'] ?? 'report')) checks.configuration = false;
  } catch { checks.configuration = false; }
  const flutter = await executableAvailable(process.env['FLUTTER_BIN'] ?? 'flutter');
  return { ready: Object.values(checks).every(Boolean) && (format !== 'flutter' || flutter),
    checks, capabilities: { html: true, react: true, vue: true, flutter } };
};

export const assertRuntimeReady = async (format: OutputFormat, model: string) => {
  const result = await checkReadiness(format, model);
  if (!result.ready) {
    const missing = Object.entries(result.checks).filter(([, ready]) => !ready).map(([name]) => name);
    if (format === 'flutter' && !result.capabilities.flutter) missing.push('Flutter SDK');
    throw new Error(`Runtime is not ready: ${missing.join(', ')}`);
  }
};

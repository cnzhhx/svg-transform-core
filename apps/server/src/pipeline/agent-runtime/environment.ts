const inheritedNames = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ', 'SystemRoot',
  'NODE_ENV', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
  'CHROMIUM_PATH', 'CHROME_PATH', 'BROWSER_PATH', 'PLAYWRIGHT_BROWSERS_PATH',
  'FLUTTER_BIN', 'PUB_CACHE', 'PNPM_HOME', 'MODEL_PROVIDER_CONFIG', 'WORKSPACE',
  'DIFF_RATIO_THRESHOLD', 'MODULE_DIFF_RATIO_THRESHOLD', 'PNG_RASTER_SCALE_MULTIPLIER',
  'CDP_OPERATION_CONCURRENCY', 'CDP_READY_TIMEOUT_MS', 'CDP_SEND_TIMEOUT_MS',
  'VERIFY_CACHE_DISABLED', 'OPENCODE_CLI_PATH',
]);

export const createAgentEnvironment = (source: NodeJS.ProcessEnv, overrides: Record<string, string | undefined> = {}) => {
  const extra = (source['AGENT_ENV_ALLOWLIST'] ?? '').split(',').map((key) => key.trim()).filter(Boolean);
  const names = new Set([...inheritedNames, ...extra]);
  return { ...Object.fromEntries(Object.entries(source).filter(([key, value]) => names.has(key) && value !== undefined)), ...overrides };
};

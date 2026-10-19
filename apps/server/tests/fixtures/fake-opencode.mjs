#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
const config = JSON.parse(await readFile(process.env.OPENCODE_CONFIG, 'utf8'));
const provider = JSON.parse(await readFile(process.env.MODEL_PROVIDER_CONFIG, 'utf8'));
await writeFile('runtime-probe.json', JSON.stringify({ pid: process.pid, configPath: process.env.OPENCODE_CONFIG,
  scoped: config.permission.external_directory['*'] === 'deny', secretFiltered: !process.env.UNRELATED_SECRET,
  selectedProviderOnly: Object.keys(provider.models).length === 1 && provider.models.selected?.apiKeyEnv === 'SVG_TRANSFORM_AGENT_API_KEY',
}));
console.log(JSON.stringify({ type: 'step_start', sessionID: 'test-session' }));
if (process.argv.includes('api-error')) {
  console.log(JSON.stringify({ type: 'error', error: { name: 'APIError', data: {
    message: 'The supplied credential is invalid', statusCode: 401,
    responseBody: JSON.stringify({ error: { message: 'The supplied credential is invalid', code: 'invalid_api_key' } }),
  } } }));
  console.error('CLI wrapper exited after the API error');
  process.exitCode = 1;
} else if (process.argv.includes('wait-for-cancel')) {
  setInterval(() => {}, 1000);
} else {
  console.log(JSON.stringify({ type: 'text', part: { text: 'offline fixture response' } }));
  console.log(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 10, output: 2 } } }));
}

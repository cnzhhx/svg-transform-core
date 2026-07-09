#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(rootDir, "dist");
const require = createRequire(import.meta.url);
const tscBin = require.resolve("typescript/bin/tsc");

const run = (command, args) => {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[build:mcp] failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

await rm(distDir, { force: true, recursive: true });
await mkdir(distDir, { recursive: true });

run(process.execPath, [
  tscBin,
  "--target",
  "ES2022",
  "--module",
  "NodeNext",
  "--moduleResolution",
  "NodeNext",
  "--esModuleInterop",
  "--skipLibCheck",
  "--noEmit",
  "false",
  "--outDir",
  distDir,
  "src/mcp/browser-mcp-server.ts",
]);

await writeFile(
  join(distDir, "browser-mcp-server.mjs"),
  'import "./mcp/browser-mcp-server.js";\n',
);

console.log("[build:mcp] wrote dist/browser-mcp-server.mjs");

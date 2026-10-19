#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(rootDir, "dist");
const compiledEntry = join(distDir, "mcp/browser-mcp-server.js");

await access(compiledEntry);

await writeFile(
  join(distDir, "browser-mcp-server.mjs"),
  'import "./mcp/browser-mcp-server.js";\n',
);

console.log("[build:mcp] verified compiled MCP server and wrote its entrypoint");

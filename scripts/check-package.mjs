#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { publint } from "publint";
import { formatMessage } from "publint/utils";

const rootDir = path.resolve(import.meta.dirname, "..");
const clientDir = path.join(rootDir, "packages/client");
const requireClient = createRequire(path.join(clientDir, "package.json"));
const manifest = JSON.parse(await readFile(path.join(clientDir, "package.json"), "utf8"));
const tempDir = await mkdtemp(path.join(tmpdir(), "svg-transform-package-"));

const runNpm = (args, cwd) =>
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    encoding: "utf8",
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"],
  });

try {
  const [packed] = JSON.parse(runNpm([
    "pack", "--json", "--ignore-scripts", "--pack-destination", tempDir,
  ], clientDir));
  const expectedFiles = [
    "LICENSE", "README.md", "dist/index.d.ts", "dist/index.js", "package.json",
  ];
  assert.deepEqual(
    packed.files.map(({ path: file }) => file).sort(),
    expectedFiles.sort(),
    "SDK tarball contents changed; review the package allowlist",
  );

  const tarball = path.join(tempDir, packed.filename);
  const { messages } = await publint({ pack: { tarball: await readFile(tarball) } });
  const problems = messages.filter(({ type }) => type === "error" || type === "warning");
  assert.equal(problems.length, 0, problems.map((message) => formatMessage(message, manifest)).join("\n"));

  const consumerDir = path.join(tempDir, "consumer");
  await mkdir(consumerDir);
  await writeFile(path.join(consumerDir, "package.json"), JSON.stringify({
    name: "sdk-package-smoke", private: true, type: "module",
  }));
  // Install only the packed SDK: workspace symlinks must not mask missing files.
  runNpm([
    "install", tarball, "--offline", "--ignore-scripts", "--no-audit",
    "--no-fund", "--package-lock=false",
  ], consumerDir);
  await copyFile(
    path.join(clientDir, "tests/package-smoke.mts"),
    path.join(consumerDir, "package-smoke.mts"),
  );
  await writeFile(path.join(consumerDir, "tsconfig.json"), JSON.stringify({
    compilerOptions: {
      module: "NodeNext", moduleResolution: "NodeNext", target: "ES2022",
      strict: true, skipLibCheck: false, noEmitOnError: true, types: [],
    },
    files: ["package-smoke.mts"],
  }));
  execFileSync(process.execPath, [requireClient.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"], {
    cwd: consumerDir, stdio: "inherit", timeout: 60_000,
  });
  execFileSync(process.execPath, ["package-smoke.mjs"], {
    cwd: consumerDir, stdio: "inherit", timeout: 30_000,
  });
  console.log(`[package-check] ${manifest.name}@${manifest.version}: tarball, exports, types, and isolated consumer passed`);
} finally {
  await rm(tempDir, { recursive: true, force: true });
}

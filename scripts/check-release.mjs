#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";

const rootDir = path.resolve(import.meta.dirname, "..");
const manifests = [
  "package.json",
  "apps/server/package.json",
  "packages/client/package.json",
];

const packages = await Promise.all(
  manifests.map(async (file) => {
    const manifest = JSON.parse(await readFile(path.join(rootDir, file), "utf8"));
    return { file, name: manifest.name, version: manifest.version };
  }),
);

const [workspace] = packages;
const mismatches = packages.filter(({ version }) => version !== workspace.version);
if (mismatches.length > 0) {
  const details = packages
    .map(({ file, name, version }) => `${file}: ${name}@${version}`)
    .join("\n");
  throw new Error(`Workspace package versions must match:\n${details}`);
}

const releaseTag = process.env.RELEASE_TAG?.trim();
if (releaseTag && releaseTag !== `v${workspace.version}`) {
  throw new Error(
    `Release tag ${releaseTag} does not match package version v${workspace.version}`,
  );
}

console.log(
  `[release-check] ${packages.length} package manifests agree on ${workspace.version}`,
);

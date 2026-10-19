import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

import {
  buildFrameworkProject,
  inlineFrameworkDistHtml,
  writeFrameworkEntryFiles,
  type FrameworkFormat,
} from "./framework-build.js";
import type { ResolvedSvgDesign } from "./design-resolve.js";
import { writeTextFile } from "./file-io.js";
import type { SessionOutputTarget } from "./output-target.js";
import { resolveFlutterProjectDir } from "./output-target.js";
import {
  buildFlutterWeb,
  publishFlutterWebEntry,
} from "./flutter-build.js";

const buildFrameworkRenderEntry = async ({
  design,
  outputTarget,
}: {
  design: ResolvedSvgDesign;
  outputTarget: SessionOutputTarget;
}) => {
  if (outputTarget.format === "html") return outputTarget.renderEntryPath;
  if (!outputTarget.frameworkBuildDir) {
    throw new Error(`Missing frameworkBuildDir for ${outputTarget.format}`);
  }

  if (outputTarget.format === "flutter") {
    await buildFlutterWeb({
      outputDir: outputTarget.frameworkBuildDir,
      projectDir: resolveFlutterProjectDir(outputTarget),
    });
    return publishFlutterWebEntry({
      outputDir: outputTarget.frameworkBuildDir,
      renderEntryPath: outputTarget.renderEntryPath,
    });
  }

  const frameworkFormat: FrameworkFormat = outputTarget.format;
  const entryDir = path.join(outputTarget.frameworkBuildDir, "entry");
  const srcDir = path.join(entryDir, "src");
  const distDir = path.join(entryDir, "dist");
  await rm(entryDir, { force: true, recursive: true });
  await mkdir(srcDir, { recursive: true });

  await writeFrameworkEntryFiles({
    designName: design.designName,
    entryDir,
    format: frameworkFormat,
    height: design.height,
    sourceEntryPath: outputTarget.sourceEntryPath,
    srcDir,
    width: design.width,
  });

  await buildFrameworkProject({
    distDir,
    entryDir,
    format: frameworkFormat,
  });

  const distHtmlPath = path.join(distDir, "index.html");
  const distHtml = await readFile(distHtmlPath, "utf8");
  const renderHtml = await inlineFrameworkDistHtml({
    distAssetsDir: path.join(distDir, "assets"),
    distDir,
    distHtml,
    renderEntryPath: outputTarget.renderEntryPath,
  });
  await writeTextFile(outputTarget.renderEntryPath, renderHtml);
  return outputTarget.renderEntryPath;
};

export { buildFrameworkRenderEntry };

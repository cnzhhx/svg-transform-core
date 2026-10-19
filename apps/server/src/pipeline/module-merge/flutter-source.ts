import { existsSync } from "node:fs";
import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

import type { ResolvedSvgDesign } from "../../core/design-resolve.js";
import type { SessionOutputTarget } from "../../core/output-target.js";
import { resolveFlutterProjectDir } from "../../core/output-target.js";
import type {
  ModuleMergeResolvedModule,
  ModulePlanSharedLayer,
} from "./types.js";

type ResolvedSharedLayer = ModulePlanSharedLayer & {
  htmlRef: string;
  region: NonNullable<ModulePlanSharedLayer["region"]>;
};

const formatDartNumber = (value: number) =>
  Number.isInteger(value) ? value.toFixed(1) : Number(value.toFixed(3)).toString();

const stripMarkdownFence = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(/^```(?:dart)?\s*\n([\s\S]*?)\n```$/i);
  return (match?.[1] ?? trimmed).trim();
};

const normalizeFlutterWidgetFragment = (value: string) => {
  let source = stripMarkdownFence(value);
  const returned = source.match(/^return\s+([\s\S]*);\s*$/);
  if (returned?.[1]) source = returned[1].trim();
  source = source.replace(/;\s*$/, "").trim();
  if (!source) throw new Error("Flutter source fragment must be non-empty");
  if (/^\s*(?:import|export|part|library|class|mixin|enum|void\s+main)\b/m.test(source)) {
    throw new Error(
      "Flutter source fragment must be one Widget expression without imports, declarations, or main()",
    );
  }
  return source;
};

const rewriteFlutterModuleAssetRefs = ({
  moduleId,
  source,
}: {
  moduleId: string;
  source: string;
}) =>
  source.replace(
    /(["'])(?:\.\/)?assets\/([^"']+)\1/g,
    (_match, quote: string, relativeAssetPath: string) => {
      const normalized = relativeAssetPath.replace(/^\/+/, "");
      const target = normalized.startsWith(`${moduleId}/`)
        ? `assets/${normalized}`
        : `assets/${moduleId}/${normalized}`;
      return `${quote}${target}${quote}`;
    },
  );

const toSafeAssetName = (value: string) =>
  value
    .trim()
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "shared-layer";

const stageFlutterModuleAssets = async ({
  moduleDir,
  moduleId,
  projectDir,
}: {
  moduleDir: string;
  moduleId: string;
  projectDir: string;
}) => {
  const sourceDir = path.join(moduleDir, "assets");
  if (!existsSync(sourceDir)) return;
  const targetDir = path.join(projectDir, "assets", moduleId);
  await mkdir(path.dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, { recursive: true });
};

const stageFlutterAssets = async ({
  modules,
  outputTarget,
  sharedLayers,
}: {
  modules: ModuleMergeResolvedModule[];
  outputTarget: SessionOutputTarget;
  sharedLayers: ResolvedSharedLayer[];
}) => {
  const projectDir = resolveFlutterProjectDir(outputTarget);
  const assetsDir = path.join(projectDir, "assets");
  await rm(assetsDir, { force: true, recursive: true });
  await mkdir(assetsDir, { recursive: true });

  await Promise.all(
    modules.map((module) =>
      stageFlutterModuleAssets({
        moduleDir: module.dir,
        moduleId: module.id,
        projectDir,
      }),
    ),
  );

  const stagedSharedLayers = await Promise.all(
    sharedLayers.map(async (layer, index) => {
      const sourcePath = path.resolve(
        path.dirname(outputTarget.renderEntryPath),
        layer.htmlRef,
      );
      const extension = path.extname(sourcePath).toLowerCase() || ".svg";
      const assetRef = `assets/shared-layers/${toSafeAssetName(layer.id || `layer-${index + 1}`)}${extension}`;
      const targetPath = path.join(projectDir, assetRef);
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath);
      return { ...layer, assetRef, extension };
    }),
  );

  return { projectDir, stagedSharedLayers };
};

const indentLines = (value: string, spaces: number) => {
  const prefix = " ".repeat(spaces);
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
};

const renderFlutterModule = (module: ModuleMergeResolvedModule) => {
  const fragment = rewriteFlutterModuleAssetRefs({
    moduleId: module.id,
    source: normalizeFlutterWidgetFragment(module.sourceFragment ?? ""),
  });
  const { x, y, width, height } = module.region;
  return `Positioned(
  left: ${formatDartNumber(x)},
  top: ${formatDartNumber(y)},
  width: ${formatDartNumber(width)},
  height: ${formatDartNumber(height)},
  child: ClipRect(
    child: SizedBox(
      width: ${formatDartNumber(width)},
      height: ${formatDartNumber(height)},
      child:
${indentLines(fragment, 8)},
    ),
  ),
)`;
};

const renderFlutterSharedLayer = (
  layer: ResolvedSharedLayer & { assetRef: string; extension: string },
) => {
  const { x, y, width, height } = layer.region;
  const image = layer.extension === ".svg"
    ? `SvgPicture.asset(${JSON.stringify(layer.assetRef)}, fit: BoxFit.fill)`
    : `Image.asset(${JSON.stringify(layer.assetRef)}, fit: BoxFit.fill)`;
  return `Positioned(
  left: ${formatDartNumber(x)},
  top: ${formatDartNumber(y)},
  width: ${formatDartNumber(width)},
  height: ${formatDartNumber(height)},
  child: ${image},
)`;
};

const createFlutterSourceEntry = ({
  design,
  modules,
  stagedSharedLayers,
}: {
  design: ResolvedSvgDesign;
  modules: ModuleMergeResolvedModule[];
  stagedSharedLayers: Array<ResolvedSharedLayer & {
    assetRef: string;
    extension: string;
  }>;
}) => {
  const children = [
    ...stagedSharedLayers.map(renderFlutterSharedLayer),
    ...modules.map(renderFlutterModule),
  ];
  const childrenSource = children.length
    ? `${children.map((child) => `${indentLines(child, 16)},`).join("\n")}`
    : "                // No generated modules.";

  return `\
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

void main() {
  runApp(const DesignApp());
}

class DesignApp extends StatelessWidget {
  const DesignApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        fontFamilyFallback: const [
          'Noto Sans CJK SC',
          'Source Han Sans SC',
          'Microsoft YaHei',
          'sans-serif',
        ],
      ),
      home: Material(
        color: Colors.transparent,
        child: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: ${formatDartNumber(design.width)},
            height: ${formatDartNumber(design.height)},
            child: Stack(
              clipBehavior: Clip.hardEdge,
              children: [
${childrenSource}
              ],
            ),
          ),
        ),
      ),
    );
  }
}
`;
};

const createFlutterModuleSourceEntry = ({
  height,
  moduleId,
  sourceFragment,
  width,
}: {
  height: number;
  moduleId: string;
  sourceFragment: string;
  width: number;
}) => {
  const fragment = rewriteFlutterModuleAssetRefs({
    moduleId,
    source: normalizeFlutterWidgetFragment(sourceFragment),
  });
  return `\
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';

void main() {
  runApp(const ModuleApp());
}

class ModuleApp extends StatelessWidget {
  const ModuleApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Material(
        color: Colors.transparent,
        child: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: ${formatDartNumber(width)},
            height: ${formatDartNumber(height)},
            child:
${indentLines(fragment, 14)},
          ),
        ),
      ),
    );
  }
}
`;
};

export {
  createFlutterModuleSourceEntry,
  createFlutterSourceEntry,
  stageFlutterAssets,
  stageFlutterModuleAssets,
};

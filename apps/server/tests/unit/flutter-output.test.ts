import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildFlutterWeb,
  publishFlutterWebEntry,
  writeFlutterProjectFiles,
} from "../../src/core/flutter-build.js";
import {
  getSourceFragmentFileName,
  parseOutputFormat,
  resolveOutputTarget,
} from "../../src/core/output-target.js";
import {
  createFlutterModuleSourceEntry,
} from "../../src/pipeline/module-merge/flutter-source.js";
import { mergeModulesIntoHtml } from "../../src/pipeline/module-merge/merge.js";

const createFakeFlutter = async (root: string) => {
  const executable = path.join(root, "fake-flutter.sh");
  await writeFile(
    executable,
    `#!/bin/sh
set -eu
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output" ]; then
    shift
    output="$1"
  fi
  shift
done
test -n "$output"
mkdir -p "$output"
printf '%s\n' '<!doctype html><html><head><base href="/"></head><body><flutter-view><canvas></canvas></flutter-view><script src="flutter_bootstrap.js"></script></body></html>' > "$output/index.html"
printf '%s\n' 'window.__fakeFlutterBuilt = true;' > "$output/flutter_bootstrap.js"
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return executable;
};

test("Flutter is a supported output target with a project entry", () => {
  assert.equal(parseOutputFormat("FLUTTER"), "flutter");
  assert.equal(getSourceFragmentFileName("flutter"), "source.fragment.dart");
  const target = resolveOutputTarget({
    format: "flutter",
    svgPath: "/tmp/dashboard.svg",
  });
  assert.equal(target.sourceEntryPath, "/tmp/dashboard.flutter/lib/main.dart");
  assert.equal(target.frameworkProjectDir, "/tmp/dashboard.flutter");
  assert.equal(
    target.frameworkBuildDir,
    "/tmp/artifacts/framework-render/flutter",
  );
});

test("Flutter widget fragments and local asset paths are normalized", () => {
  const source = createFlutterModuleSourceEntry({
    height: 80,
    moduleId: "module-001",
    sourceFragment:
      "```dart\nreturn Image.asset(\"./assets/icon.png\");\n```",
    width: 120,
  });
  assert.match(
    source,
    /Image\.asset\("assets\/module-001\/icon\.png"\)/,
  );
  assert.throws(
    () =>
      createFlutterModuleSourceEntry({
        height: 80,
        moduleId: "module-001",
        sourceFragment: "import 'dart:ui';\nText('x')",
        width: 120,
      }),
    /one Widget expression/,
  );
});

test("Flutter web builds are published with a render-relative base href", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flutter-build-test-"));
  const previousFlutterBin = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = await createFakeFlutter(root);
  try {
    const projectDir = path.join(root, "project");
    const outputDir = path.join(root, "artifacts", "framework-render", "flutter");
    const renderEntryPath = path.join(root, "design.html");
    await writeFlutterProjectFiles({
      designName: "Dashboard",
      mainDart: "void main() {}\n",
      overwrite: true,
      projectDir,
    });
    await buildFlutterWeb({ outputDir, projectDir });
    await publishFlutterWebEntry({ outputDir, renderEntryPath });
    const html = await readFile(renderEntryPath, "utf8");
    assert.match(
      html,
      /<base href="\.\/artifacts\/framework-render\/flutter\/" \/>/,
    );
  } finally {
    if (previousFlutterBin === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previousFlutterBin;
    await rm(root, { force: true, recursive: true });
  }
});

test("Flutter project metadata is bounded and HTML-safe", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flutter-metadata-test-"));
  try {
    await writeFlutterProjectFiles({
      designName: `${"页面".repeat(40)}<&\"`,
      mainDart: "void main() {}\n",
      overwrite: true,
      projectDir: root,
    });
    const pubspec = await readFile(path.join(root, "pubspec.yaml"), "utf8");
    const packageName = pubspec.match(/^name:\s*(\S+)/m)?.[1] ?? "";
    assert.equal(packageName, "design_output_flutter");
    assert.ok(packageName.length <= 64);

    const webIndex = await readFile(path.join(root, "web", "index.html"), "utf8");
    assert.doesNotMatch(webIndex, /<title>[^<]*<&/);
    assert.match(webIndex, /&lt;&amp;&quot;/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Flutter build reports a missing SDK without leaving temporary files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flutter-missing-sdk-test-"));
  const previousFlutterBin = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = path.join(root, "missing-flutter");
  try {
    const projectDir = path.join(root, "project");
    await writeFlutterProjectFiles({
      designName: "Missing SDK",
      mainDart: "void main() {}\n",
      overwrite: true,
      projectDir,
    });
    await assert.rejects(
      buildFlutterWeb({
        outputDir: path.join(root, "web-output"),
        projectDir,
      }),
      /Flutter SDK not found/,
    );
  } finally {
    if (previousFlutterBin === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previousFlutterBin;
    await rm(root, { force: true, recursive: true });
  }
});

test("Flutter module merge writes a complete project and compiled preview", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "flutter-merge-test-"));
  const previousFlutterBin = process.env.FLUTTER_BIN;
  process.env.FLUTTER_BIN = await createFakeFlutter(root);
  try {
    const svgPath = path.join(root, "dashboard.svg");
    const outputTarget = resolveOutputTarget({ format: "flutter", svgPath });
    const modulesDir = path.join(root, "artifacts", "modules");
    const moduleDir = path.join(modulesDir, "module-001");
    const scaffoldPath = path.join(modulesDir, "modules-scaffold.html");
    const modulePlanPath = path.join(modulesDir, "module-plan.json");
    await mkdir(path.join(moduleDir, "assets"), { recursive: true });
    await Promise.all([
      writeFile(
        scaffoldPath,
        '<!doctype html><html><head></head><body><main class="design-page"></main></body></html>',
        "utf8",
      ),
      writeFile(
        modulePlanPath,
        JSON.stringify({
          design: { height: 80, name: "Dashboard", width: 120 },
          modules: [
            {
              id: "module-001",
              region: { height: 80, width: 120, x: 0, y: 0 },
            },
          ],
          outputFormat: "flutter",
          renderEntryPath: outputTarget.renderEntryPath,
          scaffoldRenderPath: scaffoldPath,
          sourceEntryPath: outputTarget.sourceEntryPath,
        }),
        "utf8",
      ),
      writeFile(
        path.join(moduleDir, "preview.fragment.html"),
        '<div class="module-001">Hello Flutter</div>',
        "utf8",
      ),
      writeFile(path.join(moduleDir, "module.css"), ".module-001 {}", "utf8"),
      writeFile(
        path.join(moduleDir, "manifest.json"),
        JSON.stringify({
          moduleId: "module-001",
          region: { height: 80, width: 120, x: 0, y: 0 },
        }),
        "utf8",
      ),
      writeFile(
        path.join(moduleDir, "source.fragment.dart"),
        `Center(child: Text('Hello Flutter'))`,
        "utf8",
      ),
      writeFile(path.join(moduleDir, "assets", "pixel.png"), "asset", "utf8"),
    ]);

    const result = await mergeModulesIntoHtml({
      design: {
        designName: "Dashboard",
        height: 80,
        scale: 1,
        svgPath,
        width: 120,
      },
      modulePlanPath,
      modulesDir,
      outputTarget,
    });

    assert.equal(result.outputFormat, "flutter");
    const mainDart = await readFile(outputTarget.sourceEntryPath, "utf8");
    assert.match(mainDart, /class DesignApp extends StatelessWidget/);
    assert.match(mainDart, /Text\('Hello Flutter'\)/);
    assert.match(mainDart, /width: 120\.0/);
    assert.match(
      await readFile(outputTarget.renderEntryPath, "utf8"),
      /artifacts\/framework-render\/flutter/,
    );
    assert.equal(
      await readFile(
        path.join(outputTarget.frameworkProjectDir!, "assets", "module-001", "pixel.png"),
        "utf8",
      ),
      "asset",
    );
  } finally {
    if (previousFlutterBin === undefined) delete process.env.FLUTTER_BIN;
    else process.env.FLUTTER_BIN = previousFlutterBin;
    await rm(root, { force: true, recursive: true });
  }
});

test(
  "real Flutter SDK builds a visible web surface",
  { skip: process.env.FLUTTER_REAL_SMOKE !== "1" },
  async (t) => {
    const configuredRoot = process.env.FLUTTER_SMOKE_ROOT?.trim();
    const root = configuredRoot ||
      path.join(os.tmpdir(), "svg-transform-flutter-real-smoke");
    if (!configuredRoot) {
      t.after(() => rm(root, { force: true, recursive: true }));
    }
    const projectDir = path.join(root, "project");
    const outputDir = path.join(root, "artifacts", "framework-render", "flutter");
    const renderEntryPath = path.join(root, "design.html");
    await rm(root, { force: true, recursive: true });
    await writeFlutterProjectFiles({
      designName: "Flutter Browser Smoke",
      mainDart: createFlutterModuleSourceEntry({
        height: 240,
        moduleId: "module-001",
        sourceFragment: `Stack(
  children: [
    const Positioned(
      left: 24,
      top: 24,
      child: Text(
        'Flutter Web verified',
        style: TextStyle(
          color: Color(0xff17211b),
          fontSize: 24,
          fontWeight: FontWeight.w700,
        ),
      ),
    ),
    Positioned(
      left: 24,
      top: 78,
      child: Container(
        width: 280,
        height: 112,
        decoration: BoxDecoration(
          color: const Color(0xff146c43),
          borderRadius: BorderRadius.circular(8),
        ),
        child: const Center(
          child: Text(
            'svg-transform-core',
            style: TextStyle(color: Colors.white, fontSize: 18),
          ),
        ),
      ),
    ),
    const Positioned(
      left: 330,
      top: 112,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: Color(0xffe9b949),
          shape: BoxShape.circle,
        ),
        child: SizedBox(width: 56, height: 56),
      ),
    ),
  ],
)`,
        width: 420,
      }),
      overwrite: true,
      projectDir,
    });
    await buildFlutterWeb({ outputDir, projectDir });
    await publishFlutterWebEntry({ outputDir, renderEntryPath });
    assert.match(await readFile(renderEntryPath, "utf8"), /flutter_bootstrap\.js/);
    assert.match(
      await readFile(renderEntryPath, "utf8"),
      /artifacts\/framework-render\/flutter/,
    );
    assert.ok((await readFile(path.join(outputDir, "main.dart.js"))).length > 0);
  },
);

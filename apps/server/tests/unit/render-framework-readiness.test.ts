import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { verifyDesign } from "../../src/pipeline/verify.js";

test("render capture waits for a delayed Flutter Web mount", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".flutter-ready-test-"));
  const svgPath = path.join(root, "design.svg");
  const renderEntryPath = path.join(root, "design.html");
  const artifactDir = path.join(root, "artifacts");

  try {
    await Promise.all([
      writeFile(
        svgPath,
        '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#168040"/></svg>',
        "utf8",
      ),
      writeFile(
        renderEntryPath,
        `<!doctype html>
<html>
  <head>
    <style>
      html, body { margin: 0; width: 80px; height: 60px; }
    </style>
  </head>
  <body>
    <script src="./flutter_bootstrap.js" async></script>
    <script>
      setTimeout(() => {
        document.body.style.background = '#168040'
        const view = document.createElement('flutter-view')
        const glassPane = document.createElement('flt-glass-pane')
        const shadow = glassPane.attachShadow({ mode: 'open' })
        shadow.appendChild(document.createElement('flt-scene-host'))
        view.appendChild(glassPane)
        document.body.appendChild(view)
      }, 1200)
    </script>
  </body>
</html>`,
        "utf8",
      ),
      writeFile(path.join(root, "flutter_bootstrap.js"), "", "utf8"),
    ]);

    const startedAt = Date.now();
    const result = await verifyDesign(svgPath, undefined, artifactDir, {
      mode: "fast",
      renderEntryPath,
      scale: 1,
    });

    assert.ok(Date.now() - startedAt >= 1200);
    assert.ok(
      result.diffRatio < 0.001,
      `expected the delayed green surface to be captured, diff=${result.diffRatio}`,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

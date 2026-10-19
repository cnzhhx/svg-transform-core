import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveDesignTarget } from "../../src/core/design-resolve.js";
import {
  cropModuleSvg,
  MODULE_SVG_CROP_VERSION,
} from "../../src/core/svg-vertical-modules/module-svg-crop.js";
import type { SvgVerticalModule } from "../../src/core/svg-vertical-modules/types.js";
import { ensureModuleSvg } from "../../src/pipeline/agent-runner/module/module-artifacts.js";

const moduleFixture: SvgVerticalModule = {
  candidateNodeCount: 1,
  contentBox: { x: 0, y: 0, width: 750, height: 424 },
  diffRegion: { id: "module-05", x: 0, y: 0, width: 1500, height: 848 },
  id: "module-05",
  kind: "single-page",
  nodePaths: [],
  reason: "multiline text regression",
  region: { id: "module-05", x: 0, y: 0, width: 1500, height: 848 },
  score: 0,
  sourceContainerIds: [],
};

const svgSource = (body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 424">${body}</svg>`;

const withTempDir = async (run: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "module-svg-crop-test-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const crop = async (dir: string, body: string, nodePaths: string[] = []) => {
  const outputPath = path.join(dir, "module.svg");
  await cropModuleSvg({
    originalSvgPath: path.join(dir, "source.svg"),
    originalSvgSource: svgSource(body),
    module: { ...moduleFixture, nodePaths },
    outputPath,
    scale: 2,
  });
  return readFile(outputPath, "utf8");
};

describe("module SVG text preservation", () => {
  it("retains both lines of mixed text/tspan blocks selected by the module plan", () =>
    withTempDir(async (dir) => {
      const headline = '<text x="56.756" y="125.692">测试标题，保持换行<tspan x="56.756" dy="60">第二行文字完整保留</tspan></text>';
      const hint = '<text x="57.756" y="305.693">打开示例应用<tspan x="57.756" dy="26.4">查看示例报告</tspan></text>';
      const result = await crop(dir, `<g>${headline}${hint}<text>其他模块</text></g>`, [
        "svg:nth-of-type(1) > g:nth-of-type(1) > text:nth-of-type(1)",
        "svg:nth-of-type(1) > g:nth-of-type(1) > text:nth-of-type(2)",
      ]);
      assert.ok(result.includes(headline));
      assert.ok(result.includes(hint));
      assert.ok(!result.includes("其他模块"));
      assert.ok(result.includes('viewBox="0 0 750 424"'));
    }));

  for (const [name, text] of [
    ["single-line text", '<text x="10" y="20">第一行</text>'],
    ["all-tspan multiline text", '<text><tspan x="10">第一行</tspan><tspan x="10" dy="20">第二行</tspan></text>'],
    ["leading, interleaved and trailing text", '<text>前缀<tspan>第一段</tspan>中间<tspan>第二段</tspan>后缀</text>'],
    ["nested spans, entities and significant whitespace", '<text xml:space="preserve">  A &amp; B <tspan>内层 <tspan>文本</tspan> 尾部</tspan> 结束  </text>'],
    ["whitespace-only links inside text", '<text xml:space="preserve">A<a href="#link"> </a><tspan>B</tspan></text>'],
    ["CDATA and comments containing element-like text", '<text><![CDATA[A > <tspan opacity="0">原文</tspan>]]><!-- <tspan>注释</tspan> -->前缀<tspan>第二行</tspan>后缀</text>'],
  ] as const) {
    it(`preserves ${name} without inserting whitespace`, () =>
      withTempDir(async (dir) => {
        assert.ok((await crop(dir, text)).includes(text));
      }));
  }

  it("removes negligible elements while preserving adjacent visible text and definitions", () =>
    withTempDir(async (dir) => {
      const result = await crop(dir,
        '<defs><style>.faint { opacity: 0.005; }</style></defs>' +
        '<g><text>前缀<tspan opacity="0">隐藏文字</tspan>中间<tspan>可见文字</tspan>后缀</text>' +
        '<g opacity="0.005"><text>透明容器</text></g>' +
        '<path id="empty" fill="none" d="M0 0L10 10" />' +
        '<path id="stroke" fill="none" stroke="black" d="M0 0L10 10" />' +
        '<rect id="visible" width="10" height="10" opacity="0.4" /></g>');
      assert.ok(result.includes('<text>前缀中间<tspan>可见文字</tspan>后缀</text>'));
      assert.ok(!result.includes("隐藏文字"));
      assert.ok(!result.includes("透明容器"));
      assert.ok(!result.includes('id="empty"'));
      assert.ok(result.includes('id="stroke"'));
      assert.ok(result.includes('id="visible"'));
      assert.ok(result.includes(".faint { opacity: 0.005; }"));
    }));

  it("replaces a version-6 crop and reuses the repaired crop on subsequent reads", () =>
    withTempDir(async (dir) => {
      const svgPath = path.join(dir, "source.svg");
      const text = '<text>第一行<tspan dy="20">第二行</tspan></text>';
      await writeFile(svgPath, svgSource(text));
      const design = await resolveDesignTarget(svgPath, { format: "html", scale: 2 });
      const input = { design, module: moduleFixture, modulesRootDir: path.join(dir, "modules") };
      const moduleSvgPath = await ensureModuleSvg(input);
      const currentCrop = await readFile(moduleSvgPath, "utf8");
      await writeFile(moduleSvgPath, currentCrop
        .replace(`data-module-crop-version="${MODULE_SVG_CROP_VERSION}"`, 'data-module-crop-version="6"')
        .replace("第一行", ""));

      await ensureModuleSvg(input);
      const repaired = await readFile(moduleSvgPath, "utf8");
      assert.ok(repaired.includes(text));
      assert.ok(repaired.includes(`data-module-crop-version="${MODULE_SVG_CROP_VERSION}"`));
      assert.notEqual(MODULE_SVG_CROP_VERSION, "6");
      const cachedTime = new Date("2000-01-01T00:00:00Z");
      await utimes(moduleSvgPath, cachedTime, cachedTime);
      await ensureModuleSvg(input);
      assert.equal(await readFile(moduleSvgPath, "utf8"), repaired);
      assert.equal((await stat(moduleSvgPath)).mtimeMs, cachedTime.getTime());
    }));
});

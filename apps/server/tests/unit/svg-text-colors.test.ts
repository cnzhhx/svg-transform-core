import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { it } from "node:test";

import type { SvgVerticalModule } from "../../src/core/svg-vertical-modules/types.js";
import { createModuleSemanticDraft, isModuleSemanticInputCurrent } from "../../src/pipeline/agent-runner/module/module-semantic.js";
import { resolveDesignTarget } from "../../src/core/design-resolve.js";
import { preprocessModuleSemantic } from "../../src/pipeline/agent-runner/module/module-semantic-preprocess.js";
import { buildDeterministicSemantic } from "../../src/pipeline/agent-runner/module/module-semantic-deterministic.js";
import { Semaphore } from "../../src/pipeline/agent-runner/queue/concurrency.js";

for (const scale of [1, 2]) {
  it(`preprocesses each native SVG text as one block with two correctly spaced lines at ${scale}x`, async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "svg-text-colors-"));
    try {
      const moduleSvgPath = path.join(dir, "module.svg");
      await writeFile(moduleSvgPath, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 424">
        <defs><style>
          .headline { font-size: 40px; fill: #312a2c; }
          .hint { font-size: 22px; opacity: 0.4; }
        </style></defs>
        <text id="headline" class="headline" x="56.756" y="125.692">测试标题，保持换行<tspan x="56.756" dy="60">第二行文字完整保留</tspan></text>
        <text id="hint" class="hint" x="57.756" y="305.693">打开示例应用<tspan x="57.756" dy="26.4">查看示例报告</tspan></text>
      </svg>`);
      const region = { id: "module-05", x: 0, y: 0, width: 750 * scale, height: 424 * scale };
      const module: SvgVerticalModule = {
        candidateNodeCount: 4, contentBox: region, diffRegion: region,
        id: region.id, kind: "single-page", nodePaths: [], reason: "text color regression",
        region, score: 0, sourceContainerIds: [],
      };
      await createModuleSemanticDraft({
        module, moduleDir: dir, moduleSvgPath, scale,
      });
      const { textBlocksFile, textStyleHintsFile } = await preprocessModuleSemantic({
        controller: new AbortController(),
        design: await resolveDesignTarget(moduleSvgPath, { format: "html", scale }),
        module, moduleDir: dir, moduleSvgPath,
        sessionId: "native-text-regression", visionSemaphore: new Semaphore(1),
      });
      assert.equal(textBlocksFile.blockCount, 2, "tspans must not be emitted again as independent text blocks");
      const expectedTexts = ["测试标题，保持换行\n第二行文字完整保留", "打开示例应用\n查看示例报告"];
      const expectedColors = ["rgb(49, 42, 44)", "rgba(0, 0, 0, 0.4)"];
      const expectedLineHeights = [60 * scale, 26.4 * scale];
      const payload = JSON.parse(await readFile(path.join(dir, "module-semantic.json"), "utf8"));
      assert.equal(payload.textBlocks.length, 2);
      const freshness = { moduleDir: dir, moduleSvgPath, module, scale };
      assert.equal(await isModuleSemanticInputCurrent(freshness), true);
      if (scale === 1) {
        const jsonPath = path.join(dir, 'module-semantic.json');
        const intact = await readFile(jsonPath, 'utf8');
        const stale = JSON.parse(intact);
        stale.textBlocks[0].text = 'stale payload';
        await writeFile(jsonPath, JSON.stringify(stale));
        assert.equal(await isModuleSemanticInputCurrent(freshness), false, 'a newer debug document must not conceal a stale agent payload');
        await writeFile(jsonPath, intact);
        const current = JSON.parse(intact);
        current.generatedAssets.push({ id: 'retained-asset', path: './assets/retained.png' });
        await writeFile(jsonPath, JSON.stringify(current));
        const reused = await createModuleSemanticDraft(freshness);
        assert.equal(reused.document.generatedAssets.at(-1)?.id, 'retained-asset');
        assert.equal(reused.document.runtime.sourceFingerprint, JSON.parse(await readFile(path.join(dir, 'module-semantic.debug.json'), 'utf8')).runtime.sourceFingerprint);
        assert.equal(await isModuleSemanticInputCurrent({ ...freshness, scale: 2 }), false);
        const source = await readFile(moduleSvgPath, 'utf8');
        await writeFile(moduleSvgPath, source.replace('#312a2c', '#123456'));
        assert.equal(await isModuleSemanticInputCurrent(freshness), false, 'source content changes must invalidate preprocessing');
      }
      for (const [index, block] of textBlocksFile.blocks.entries()) {
        assert.equal(block.text, expectedTexts[index]);
        assert.equal(block.lineCount, 2);
        assert.equal(block.color, expectedColors[index]);
        assert.equal(block.lineRegions?.length, 2);
        const delta = block.lineRegions![1]!.y - block.lineRegions![0]!.y;
        assert.ok(Math.abs(delta - expectedLineHeights[index]!) < 0.01);
        const style = textStyleHintsFile.blocks.find(item => item.id === block.id)!.declarations;
        assert.equal(style.color, expectedColors[index]);
        assert.equal(style["white-space"], "pre");
        assert.ok(Math.abs(Number.parseFloat(style["line-height"]!) - expectedLineHeights[index]!) <= 1,
          "line height must follow source line spacing instead of the whole two-line box height");
        assert.equal(payload.textBlocks[index].text, expectedTexts[index]);
        assert.equal(payload.textBlocks[index].lineCount, 2);
        assert.deepEqual(payload.textBlocks[index].lineRegions, block.lineRegions);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

it('preserves significant whitespace, combining characters and emoji in native text geometry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'svg-unicode-lines-'));
  try {
    const moduleSvgPath = path.join(dir, 'module.svg');
    const samples = ['  A  B  ', 'e\u0301 👨‍👩‍👧‍👦', 'before\u200dafter'];
    await writeFile(moduleSvgPath, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 160"><g font-size="24">${samples.map((text, index) => `<text xml:space="preserve" x="20" y="${35 + index * 45}">${text}</text>`).join('')}</g></svg>`);
    const region = { id: 'module-01', x: 0, y: 0, width: 600, height: 160 };
    const { document } = await createModuleSemanticDraft({ moduleDir: dir, moduleSvgPath, scale: 1,
      module: { id: region.id, region, contentBox: region, diffRegion: region, kind: 'single-page',
        candidateNodeCount: samples.length, nodePaths: [], sourceContainerIds: [], score: 0, reason: 'unicode fixture' } });
    const texts = document.nodes.filter(node => node.tag === 'text').map(node => buildDeterministicSemantic(node)?.text);
    assert.deepEqual(texts, samples);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('treats completed preprocessing with no text as a reusable cache entry', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'svg-empty-text-'));
  try {
    const moduleSvgPath = path.join(dir, 'module.svg');
    await writeFile(moduleSvgPath, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 80"><rect width="100" height="80" fill="#336699"/></svg>');
    const region = { id: 'module-01', x: 0, y: 0, width: 100, height: 80 };
    const module: SvgVerticalModule = { id: region.id, region, diffRegion: region, contentBox: region,
      kind: 'single-page', candidateNodeCount: 1, nodePaths: [], sourceContainerIds: [], score: 0, reason: 'empty-text fixture' };
    const input = { moduleDir: dir, moduleSvgPath, module, scale: 1 };
    await createModuleSemanticDraft(input);
    const result = await preprocessModuleSemantic({ controller: new AbortController(),
      design: await resolveDesignTarget(moduleSvgPath, { format: 'html', scale: 1 }),
      module, moduleDir: dir, moduleSvgPath, sessionId: 'empty-text-fixture', visionSemaphore: new Semaphore(1) });
    assert.equal(result.textBlocksFile.blockCount, 0);
    assert.equal(result.textStyleHintsFile.blockCount, 0);
    assert.equal(await isModuleSemanticInputCurrent(input), true);
    const reused = await createModuleSemanticDraft(input);
    assert.equal(reused.document.textBlocks.length, 0);
    assert.ok(reused.document.runtime.completedStages.includes('text-style-inference'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("keeps inline tspans on one line and nested multiline tspans in their owning text block", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "svg-native-lines-"));
  try {
    const moduleSvgPath = path.join(dir, "module.svg");
    await writeFile(moduleSvgPath, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 750 424">
      <g font-size="22">
        <text x="20" y="50">第一段<tspan>同行</tspan>结尾</text>
        <text><tspan x="20" y="130">第一行</tspan><tspan x="20" y="165">第二行</tspan></text>
        <text x="20" y="240">首行<tspan x="100" dy="35">第二<tspan>行</tspan></tspan></text>
        <text x="700" y="310">首行<tspan x="700" dy="35">尾部不能丢失</tspan></text>
      </g>
    </svg>`);
    const region = { id: "module-01", x: 0, y: 0, width: 750, height: 424 };
    const { document } = await createModuleSemanticDraft({
      module: {
        candidateNodeCount: 8, contentBox: region, diffRegion: region,
        id: region.id, kind: "single-page", nodePaths: [], reason: "native text lines",
        region, score: 0, sourceContainerIds: [],
      },
      moduleDir: dir, moduleSvgPath, scale: 1,
    });
    const texts = document.nodes.filter(node => node.tag === "text").map(buildDeterministicSemantic);
    assert.deepEqual(texts.map(text => text?.text), ["第一段同行结尾", "第一行\n第二行", "首行\n第二行", "首行\n尾部不能丢失"]);
    assert.deepEqual(texts.map(text => text?.lineCount), [1, 2, 2, 2]);
    assert.equal(texts[2]!.lineRegions![1]!.x - texts[2]!.lineRegions![0]!.x, 80);
    assert.ok(texts[3]!.lineRegions![1]!.width > 50, "text outside the viewport must retain its full geometry");
    for (const node of document.nodes.filter(node => node.tag === "tspan")) {
      assert.equal(buildDeterministicSemantic(node)?.textHandling, "ignore");
    }
    for (const text of texts.slice(1)) {
      assert.equal(text!.lineRegions![1]!.y - text!.lineRegions![0]!.y, 35);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

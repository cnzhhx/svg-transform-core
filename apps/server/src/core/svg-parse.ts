import { readFile } from "node:fs/promises";
import { SaxesParser } from "saxes";

const DEFAULT_SCALE = 1;

type SvgDimensions = {
  height: number;
  width: number;
};

const readSvgDimensions = (svg: string): SvgDimensions | null => {
  const parser = new SaxesParser({ xmlns: false });
  let attrs: Record<string, string> = {};
  const rootFound = Symbol('root-found');
  parser.on('opentag', (tag) => {
    if (tag.name.split(':').at(-1) === 'svg') attrs = tag.attributes;
    throw rootFound;
  });
  try { parser.write(svg).close(); } catch (error) { if (error !== rootFound) return null; }
  const getAttr = (name: string) => attrs[name];
  const parseNumber = parseSvgLength;

  const viewBox = getAttr("viewBox");
  const viewBoxNumbers = viewBox
    ?.trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBoxNumbers && viewBoxNumbers.length === 4 && viewBoxNumbers.every(Number.isFinite)) {
    const width = viewBoxNumbers[2]!;
    const height = viewBoxNumbers[3]!;
    if (width > 0 && height > 0) {
      return { height: Math.ceil(height), width: Math.ceil(width) };
    }
  }

  const width = parseNumber(getAttr("width"));
  const height = parseNumber(getAttr("height"));
  if (width !== undefined && height !== undefined && width > 0 && height > 0) {
    return { height: Math.ceil(height), width: Math.ceil(width) };
  }

  return null;
};

const parseSvgSize = async (svgPath: string, scale = DEFAULT_SCALE) => {
  const svg = await readFile(svgPath, "utf8");
  const dims = readSvgDimensions(svg);
  if (!dims) {
    throw new Error(`Unable to read SVG size: ${svgPath}`);
  }
  return {
    width: Math.round(dims.width * scale),
    height: Math.round(dims.height * scale),
  };
};

const SVG_UNITS: Record<string, number> = {
  "": 1, px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4,
  q: 96 / 101.6, pt: 96 / 72, pc: 16,
};

const parseSvgLength = (value: string | undefined) => {
  const match = value?.trim().match(/^([+-]?(?:\d*\.\d+|\d+\.?\d*)(?:e[+-]?\d+)?)([a-z]*)$/i);
  if (!match) return undefined;
  const factor = SVG_UNITS[match[2]!.toLowerCase()];
  if (factor === undefined) return undefined;
  const result = Number(match[1]) * factor;
  return Number.isFinite(result) && result > 0 ? result : undefined;
};

type SvgInputLimits = { maxNodes: number; maxPixels: number; maxDimension: number };
const validateSvgInput = (markup: string, scale = 1, limits: SvgInputLimits = {
  maxNodes: 100_000, maxPixels: 40_000_000, maxDimension: 32_768,
}) => {
  let nodeCount = 0;
  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => { throw new Error("SVG DOCTYPE declarations are not supported"); });
  parser.on("opentag", (tag) => {
    if (nodeCount === 0 && (tag.local !== "svg" || (tag.uri && tag.uri !== "http://www.w3.org/2000/svg"))) {
      throw new Error("Document root must be an SVG element");
    }
    if (++nodeCount > limits.maxNodes) throw new Error("SVG exceeds the node limit");
  });
  parser.write(markup).close();
  const dimensions = readSvgDimensions(markup);
  if (!dimensions || !Number.isFinite(scale) || scale <= 0) throw new Error("SVG requires valid dimensions or viewBox");
  const width = Math.ceil(dimensions.width * scale);
  const height = Math.ceil(dimensions.height * scale);
  // Width and height already include the requested render scale.
  if (width > limits.maxDimension || height > limits.maxDimension || width * height > limits.maxPixels) {
    throw new Error("SVG exceeds the rendered dimension or pixel budget");
  }
  return { width, height, nodeCount };
};

/**
 * Ensure the SVG has an explicit viewBox attribute. Without a viewBox, browsers
 * will NOT scale SVG content when the CSS box size differs from the intrinsic
 * width/height attributes. This means getBoundingClientRect() returns original
 * SVG coordinates instead of scaled pixels, breaking the pipeline's assumption
 * that pixelBox values are in rendered (scaled) coordinates.
 */
const ensureSvgViewBox = (markup: string): string => {
  const searchable = markup.replace(/<!--[\s\S]*?-->/g, (comment) => ' '.repeat(comment.length));
  const svgOpenMatch = searchable.match(/<svg\b([^>]*)>/i);
  if (!svgOpenMatch) return markup;
  const attrs = svgOpenMatch[1] ?? "";

  // Already has a viewBox — nothing to do.
  if (/\bviewBox\s*=/i.test(attrs)) return markup;

  // Extract intrinsic width/height to derive a viewBox.
  const widthMatch = attrs.match(
    /\bwidth\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  );
  const heightMatch = attrs.match(
    /\bheight\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i,
  );
  const parseNum = (m: RegExpMatchArray | null) => {
    const raw = m?.[1] ?? m?.[2] ?? m?.[3];
    const num = parseSvgLength(raw) ?? NaN;
    return Number.isFinite(num) && num > 0 ? num : undefined;
  };
  const w = parseNum(widthMatch);
  const h = parseNum(heightMatch);
  if (!w || !h) return markup;

  // Inject viewBox right after the opening <svg tag so content scales properly.
  const viewBox = `viewBox="0 0 ${w} ${h}"`;
  const index = (svgOpenMatch.index ?? 0) + 4;
  return `${markup.slice(0, index)} ${viewBox}${markup.slice(index)}`;
};

export { ensureSvgViewBox, parseSvgSize, readSvgDimensions, validateSvgInput, parseSvgLength };

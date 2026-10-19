type TextBox = { text: string; x: number; y: number; width: number; height: number };
const normalize = (text: string) => text.replace(/\s+/g, '').normalize('NFKC');

export const compareTextBoxes = (expected: TextBox[], actual: TextBox[]) => {
  const used = new Set<number>();
  const missing: string[] = [];
  const offsets: Array<{ text: string; distance: number }> = [];
  for (const source of expected) {
    const matches = actual.map((box, index) => ({ box, index }))
      .filter(({ box, index }) => !used.has(index) && normalize(box.text) === normalize(source.text))
      .sort((a, b) => Math.hypot(a.box.x - source.x, a.box.y - source.y) - Math.hypot(b.box.x - source.x, b.box.y - source.y));
    const match = matches[0];
    if (!match) { missing.push(source.text); continue; }
    used.add(match.index);
    const distance = Math.hypot(match.box.x - source.x, match.box.y - source.y);
    if (distance > 2) offsets.push({ text: source.text, distance: Math.round(distance * 100) / 100 });
  }
  const known = new Set(expected.map((box) => normalize(box.text)));
  const duplicates = actual.filter((box, index) => !used.has(index) && known.has(normalize(box.text))).map((box) => box.text);
  return { advisory: true, expectedCount: expected.length, observedCount: actual.length, missing, duplicates, offsets,
    limitation: 'DOM text only; split runs, rasterized text and canvas renderers may not match.' };
};
export type { TextBox };

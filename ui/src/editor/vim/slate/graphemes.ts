/**
 * Grapheme-cluster boundary math over UTF-16 code-unit offsets.
 *
 * Vim columns and Slate points both use UTF-16 code units, but a user-visible
 * "character" (surrogate-pair emoji, combining cluster, ZWJ sequence) can span
 * several units. Every ±1 column step in the vim layer must route through
 * these helpers so operations never split a cluster.
 */
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The segment containing code unit `off`, when 0 <= off < text.length. */
function containing(text: string, off: number): Intl.SegmentData | undefined {
  return segmenter.segment(text).containing(off);
}

/** The grapheme boundary after `off`; `text.length` at or past the end. */
export function nextBoundary(text: string, off: number): number {
  if (off >= text.length) return text.length;
  const seg = containing(text, Math.max(0, off));
  return seg ? seg.index + seg.segment.length : text.length;
}

/** The grapheme boundary before `off`; 0 at or before the start. */
export function prevBoundary(text: string, off: number): number {
  if (off <= 0) return 0;
  const seg = containing(text, Math.min(off, text.length) - 1);
  return seg ? seg.index : 0;
}

/** Snap `off` down to the start of the grapheme containing it. */
export function floorBoundary(text: string, off: number): number {
  if (off <= 0) return 0;
  if (off >= text.length) return text.length;
  const seg = containing(text, off);
  return seg ? seg.index : off;
}

/** Advance `n` graphemes from `off` (negative moves back), clamped. */
export function advanceGraphemes(text: string, off: number, n: number): number {
  let pos = floorBoundary(text, off);
  for (let i = 0; i < Math.abs(n); i++) {
    const next = n > 0 ? nextBoundary(text, pos) : prevBoundary(text, pos);
    if (next === pos) break;
    pos = next;
  }
  return pos;
}

/** The full grapheme starting at (or containing) `off`; "" at the end. */
export function graphemeAt(text: string, off: number): string {
  if (off < 0 || off >= text.length) return "";
  return containing(text, off)?.segment ?? "";
}

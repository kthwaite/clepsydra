const ROMANS_UPPER = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];
const ROMANS_LOWER = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];

/** Hash a vault path into a stable Roman-numeral folio code like "VII·iii". */
export function shortFolio(path: string): string {
  let h = 0;
  for (let i = 0; i < path.length; i++) h = (h * 31 + path.charCodeAt(i)) | 0;
  const a = Math.abs(h) % ROMANS_UPPER.length;
  const b = Math.abs(h >> 5) % ROMANS_LOWER.length;
  return `${ROMANS_UPPER[a]}·${ROMANS_LOWER[b]}`;
}

/** Strip YAML frontmatter and return the first non-empty paragraph as a single line. */
export function firstParagraph(body: string): string {
  if (!body) return "";
  const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, "");
  const para = stripped.split(/\n{2,}/).find((p) => p.trim().length > 0) ?? "";
  return para.replace(/\s+/g, " ").trim();
}

/** Count words in a markdown body, ignoring frontmatter. */
export function countWords(body: string): number {
  if (!body) return 0;
  const stripped = body.replace(/^---\n[\s\S]*?\n---\n/, "");
  return stripped.split(/\s+/).filter(Boolean).length;
}

type SlateLike = { text?: string; children?: SlateLike[] };

/** Count words in a Slate value by walking all text leaves recursively. */
export function countWordsFromSlate(value: unknown): number {
  if (!Array.isArray(value)) return 0;
  let count = 0;
  const walk = (n: SlateLike) => {
    if (typeof n.text === "string") {
      const words = n.text.trim().split(/\s+/).filter(Boolean);
      count += words.length;
      return;
    }
    if (Array.isArray(n.children)) n.children.forEach(walk);
  };
  (value as SlateLike[]).forEach(walk);
  return count;
}

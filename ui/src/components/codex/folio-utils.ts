/** FNV-1a 32-bit hash of a string, rendered as a 7-char base-36 code. */
function hashFolio(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0");
}

/**
 * Folio code for a vault path. Page filenames carry an embedded 8-char base62
 * short id in the shape `<yyyymmdd>.<title-slug>.<shortid>.md` (ADR 0002), so
 * use that directly. Paths without one (e.g. journal/aggregate paths) fall back
 * to a hash of the path.
 */
export function shortFolio(path: string): string {
  const base = (path.split("/").pop() ?? path).replace(/\.md$/i, "");
  const parts = base.split(".");
  if (parts.length >= 3) {
    const id = parts[parts.length - 1];
    if (/^[0-9A-Za-z]{8}$/.test(id)) return id;
  }
  return hashFolio(path);
}

/** Strip a leading YAML frontmatter block, if present. */
export function stripFrontmatter(body: string): string {
  return body.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

/**
 * Prepare a markdown body for rendering inside a preview card: drop frontmatter
 * and cap the source so we never parse a whole large note for a hover. The cap
 * is taken at a line boundary, and a dangling (odd) code fence is closed so a
 * truncated ``` block doesn't swallow the rest of the render.
 */
export function previewMarkdownSource(body: string, maxChars = 1400): string {
  const stripped = stripFrontmatter(body).replace(/^\s+/, "");
  if (stripped.length <= maxChars) return stripped.trimEnd();
  let cut = stripped.slice(0, maxChars);
  const lastNl = cut.lastIndexOf("\n");
  if (lastNl > maxChars / 2) cut = cut.slice(0, lastNl);
  const fences = (cut.match(/```/g) ?? []).length;
  if (fences % 2 === 1) cut += "\n```";
  return cut.trimEnd();
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

export type FootnoteDef = { id: string; text: string };

export function extractFootnoteDefinitions(md: string): FootnoteDef[] {
  if (!md) return [];
  const lines = md.split("\n");
  const out: FootnoteDef[] = [];
  const seen = new Set<string>();
  let current: FootnoteDef | null = null;
  const startRe = /^\[\^([^\]]+)\]:\s*(.*)$/;

  const flush = () => {
    if (!current) return;
    if (!seen.has(current.id)) {
      seen.add(current.id);
      out.push({ id: current.id, text: current.text.trim() });
    }
    current = null;
  };

  for (const raw of lines) {
    const m = raw.match(startRe);
    if (m) {
      flush();
      current = { id: m[1], text: m[2] };
      continue;
    }
    if (current) {
      if (raw.trim() === "") {
        flush();
        continue;
      }
      // continuation line — collapse leading indent to single space
      current.text += ` ${raw.trim()}`;
    }
  }
  flush();
  return out;
}

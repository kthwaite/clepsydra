export type TocEntry = { number: string; depth: number; text: string };

type SlateNode = {
  type?: string;
  level?: number;
  time?: string;
  children?: Array<SlateNode | { text?: string }>;
};

export function buildToc(value: unknown): TocEntry[] {
  if (!Array.isArray(value)) return [];
  const counters = [0, 0, 0, 0, 0, 0];
  const entries: TocEntry[] = [];

  for (const node of value as SlateNode[]) {
    const ordinaryDepth =
      node?.type === "heading" && typeof node.level === "number"
        ? Math.max(1, Math.min(node.level, 6))
        : null;
    const journalTime =
      node?.type === "journal-time" &&
      typeof node.time === "string" &&
      node.time.length > 0
        ? node.time
        : null;
    const depth = journalTime === null ? ordinaryDepth : 2;
    if (depth === null) continue;

    counters[depth - 1] += 1;
    for (let index = depth; index < counters.length; index += 1) {
      counters[index] = 0;
    }
    const number = counters
      .slice(0, depth)
      .filter((count) => count > 0)
      .join(".");
    const text = journalTime ?? (nodeText(node).trim() || "(untitled)");
    entries.push({ number, depth, text });
  }

  return entries;
}

function nodeText(node: SlateNode | { text?: string }): string {
  if ("text" in node && typeof node.text === "string") return node.text;
  if ("children" in node && Array.isArray(node.children)) {
    return node.children.map(nodeText).join("");
  }
  return "";
}

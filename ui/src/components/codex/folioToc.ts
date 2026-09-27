export type TocEntry = { number: string; depth: number; text: string };

type SlateNode = {
  type?: string;
  level?: number;
  time?: string;
  date?: string;
  children?: Array<SlateNode | { text?: string }>;
};

/**
 * Rendered content for a block that shows Markdown the Slate value does not
 * hold (a template-rendered Base embed, a generated region), as Slate nodes.
 * `null` leaves the block out of the outline.
 */
export type TocExpander = (node: unknown) => readonly unknown[] | null;

/**
 * Numbered outline of a Folio's headings in document order. With `expand`, a
 * block's rendered headings join the outline at the block's position, so the
 * entries stay in the same order as the headings in the DOM.
 */
export function buildToc(value: unknown, expand?: TocExpander): TocEntry[] {
  if (!Array.isArray(value)) return [];
  const counters = [0, 0, 0, 0, 0, 0];
  const entries: TocEntry[] = [];

  const nodes = (value as SlateNode[]).flatMap(
    (node) => (expand?.(node) as SlateNode[] | null | undefined) ?? [node],
  );
  for (const node of nodes) {
    const ordinaryDepth =
      node?.type === "heading" && typeof node.level === "number"
        ? Math.max(1, Math.min(node.level, 6))
        : null;
    const journalTime =
      node?.type === "journal-time" &&
      typeof node.time === "string" &&
      node.time.length > 0
        ? typeof node.date === "string" && node.date.length > 0
          ? `${node.date} ${node.time}`
          : node.time
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

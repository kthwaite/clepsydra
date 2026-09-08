/**
 * Best-match ordering for palette commands.
 *
 * Tiers (lower wins): 0 exact title, 1 title prefix, 2 word prefix within the
 * title, 3 substring of title or id. Items that hit no tier are dropped. Order
 * within a tier is the input order. An empty query returns the input as is.
 */

const WORD_BOUNDARY = /[^\p{L}\p{N}]+/u;

function scoreCommand(title: string, id: string, ql: string): number | null {
  const tl = title.toLowerCase();
  if (tl === ql) return 0;
  if (tl.startsWith(ql)) return 1;
  if (tl.split(WORD_BOUNDARY).some((word) => word.startsWith(ql))) return 2;
  if (tl.includes(ql) || id.toLowerCase().includes(ql)) return 3;
  return null;
}

export function rankCommands<T extends { title: string; id: string }>(
  items: T[],
  q: string,
): T[] {
  const ql = q.toLowerCase();
  if (!ql) return items;
  const scored: Array<{ item: T; score: number }> = [];
  for (const item of items) {
    const score = scoreCommand(item.title, item.id, ql);
    if (score !== null) scored.push({ item, score });
  }
  // Array.prototype.sort is stable, so input order survives within a tier.
  scored.sort((a, b) => a.score - b.score);
  return scored.map((entry) => entry.item);
}

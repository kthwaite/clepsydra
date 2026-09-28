/**
 * Pure column-order moves. An order is a list of column ids. Pinned columns
 * never move, and no move places a column before a pinned one. Each function
 * returns the new order, or `null` when the move changes nothing.
 */

export type ColumnDropEdge = "left" | "right";

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Insert `id` into `rest` at `index`, but never before a pinned column. */
function insertAfterPins(
  rest: readonly string[],
  id: string,
  index: number,
  pinned: readonly string[],
): string[] {
  const lastPin = rest.reduce(
    (last, other, i) => (pinned.includes(other) ? i : last),
    -1,
  );
  const next = [...rest];
  next.splice(Math.max(index, lastPin + 1), 0, id);
  return next;
}

function finish(order: readonly string[], next: string[]): string[] | null {
  return sameOrder(order, next) ? null : next;
}

/**
 * Move `id` one step (`delta`) among the visible, movable columns: it swaps
 * places with its visible neighbour. Hidden columns keep their slots.
 */
export function moveColumnBy(
  order: readonly string[],
  id: string,
  delta: -1 | 1,
  pinned: readonly string[],
  visible: readonly string[],
): string[] | null {
  if (pinned.includes(id) || !visible.includes(id) || !order.includes(id)) {
    return null;
  }
  const movable = order.filter(
    (other) => visible.includes(other) && !pinned.includes(other),
  );
  const neighbour = movable[movable.indexOf(id) + delta];
  if (neighbour === undefined) return null;
  const rest = order.filter((other) => other !== id);
  const at = rest.indexOf(neighbour) + (delta > 0 ? 1 : 0);
  return finish(order, insertAfterPins(rest, id, at, pinned));
}

/** Move `id` to the `edge` side of `targetId` (a drop). */
export function moveColumnTo(
  order: readonly string[],
  id: string,
  targetId: string,
  edge: ColumnDropEdge,
  pinned: readonly string[],
): string[] | null {
  if (id === targetId || pinned.includes(id)) return null;
  if (!order.includes(id) || !order.includes(targetId)) return null;
  const rest = order.filter((other) => other !== id);
  const at = rest.indexOf(targetId) + (edge === "right" ? 1 : 0);
  return finish(order, insertAfterPins(rest, id, at, pinned));
}

import { type RefObject, useEffect, useLayoutEffect, useRef } from "react";

/**
 * Roving focus for a `<table role="grid">`, modelled on React Aria's grid
 * (focus mode "row", child focus inside cells). It is DOM-driven: rows and
 * cells are read from the table at event time, so it survives row
 * re-renders; a remounted table gets a fresh tab stop.
 *
 * A "key" is a body `<tr>` or a `<td>`/`<th>`. The grid is one tab stop:
 * the table holds tabIndex 0 until a key is focused, then that key holds it.
 *
 * Controls inside `[data-grid-skip]` (column resizers) are left out of
 * navigation and the tab sequence, as in React Aria's resizable table:
 * Enter on a header cell focuses its skipped control ("resize mode"), whose
 * keys are its own except Escape/Enter/Tab (back to the cell) and Alt+Arrow
 * (header move).
 */
interface GridNavigationOptions {
  /** Enter on a focused body row, or on a bare cell (not on its controls). */
  onActivateRow?(tr: HTMLTableRowElement): void;
  /** Alt+ArrowLeft/Right on a focused header cell or its control. */
  onHeaderMove?(th: HTMLTableCellElement, delta: -1 | 1): void;
}

const FOCUSABLE = [
  "input:not([disabled]):not([type=hidden])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "button:not([disabled])",
  "a[href]",
  "area[href]",
  "summary",
  "iframe",
  '[contenteditable]:not([contenteditable="false"])',
  "[tabindex]",
].join(",");

/** Input types that do not use arrow keys, so the grid may navigate from them. */
const NON_TEXT_INPUTS = new Set([
  "checkbox",
  "button",
  "submit",
  "reset",
  "image",
]);

function isHidden(el: Element, root: Element): boolean {
  for (let node: Element | null = el; node && node !== root; ) {
    if (node.hasAttribute("hidden") || node.hasAttribute("inert")) return true;
    node = node.parentElement;
  }
  return false;
}

const SKIP = "[data-grid-skip]";

function isSkipped(el: Element, root: Element): boolean {
  const skip = el.closest(SKIP);
  return skip !== null && root.contains(skip);
}

/** Focusable descendants of a cell, in document order (the cell excluded);
 *  controls inside `[data-grid-skip]` are not part of navigation. */
export function focusableChildren(cell: Element): HTMLElement[] {
  return Array.from(cell.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !isHidden(el, cell) && !isSkipped(el, cell),
  );
}

/** The cell's skipped control (its resizer), if any. */
function skippedControl(cell: Element): HTMLElement | null {
  return (
    Array.from(cell.querySelectorAll<HTMLElement>(FOCUSABLE)).find(
      (el) => !isHidden(el, cell) && isSkipped(el, cell),
    ) ?? null
  );
}

/** True when arrow keys belong to the target (text entry or an open editor). */
export function isEditorTarget(el: Element): boolean {
  if (el.closest("[data-grid-editor]")) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    return true;
  }
  return (
    el.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

type Key = HTMLTableRowElement | HTMLTableCellElement;
type ChildFocus = "first" | "last";

function bodyRows(table: HTMLTableElement): HTMLTableRowElement[] {
  return Array.from(table.tBodies).flatMap((body) => Array.from(body.rows));
}

function headerRow(table: HTMLTableElement): HTMLTableRowElement | null {
  const rows = table.tHead?.rows;
  return rows?.length ? rows[rows.length - 1] : null;
}

function isHeaderRow(table: HTMLTableElement, row: HTMLTableRowElement) {
  return row.parentElement === table.tHead;
}

/** The key (cell, else body row) that owns `el`, when `el` is in `table`. */
function keyOf(table: HTMLTableElement, el: Element): Key | null {
  const cell = el.closest("td, th");
  if (cell instanceof HTMLTableCellElement && table.contains(cell)) return cell;
  const row = el.closest("tr");
  if (row instanceof HTMLTableRowElement && table.contains(row)) {
    return isHeaderRow(table, row) ? null : row;
  }
  return null;
}

function isRow(key: Key): key is HTMLTableRowElement {
  return key instanceof HTMLTableRowElement;
}

function rowOf(key: Key): HTMLTableRowElement {
  return isRow(key) ? key : (key.parentElement as HTMLTableRowElement);
}

function cellAt(row: HTMLTableRowElement | undefined | null, index: number) {
  if (!row || row.cells.length === 0) return null;
  return row.cells[Math.min(index, row.cells.length - 1)];
}

function rowAbove(table: HTMLTableElement, row: HTMLTableRowElement) {
  if (isHeaderRow(table, row)) return null;
  const rows = bodyRows(table);
  const at = rows.indexOf(row);
  return at > 0 ? rows[at - 1] : headerRow(table);
}

function rowBelow(table: HTMLTableElement, row: HTMLTableRowElement) {
  const rows = bodyRows(table);
  if (isHeaderRow(table, row)) return rows[0] ?? null;
  return rows[rows.indexOf(row) + 1] ?? null;
}

/** Vertical neighbour: same column for a cell; for a row, the row (or header). */
function keyVertical(table: HTMLTableElement, key: Key, dir: -1 | 1) {
  const row = rowOf(key);
  const next = dir < 0 ? rowAbove(table, row) : rowBelow(table, row);
  if (!next) return null;
  if (!isRow(key)) return cellAt(next, key.cellIndex);
  return isHeaderRow(table, next) ? cellAt(next, 0) : next;
}

function keyHorizontal(table: HTMLTableElement, key: Key, dir: -1 | 1) {
  if (isRow(key)) return cellAt(key, dir > 0 ? 0 : key.cells.length - 1);
  const row = rowOf(key);
  const cells = row.cells;
  const next = cells[key.cellIndex + dir];
  if (next) return next;
  // Header cells wrap within the header row; body cells step out to the row.
  if (isHeaderRow(table, row)) return cells[dir > 0 ? 0 : cells.length - 1];
  return row;
}

function keyHomeEnd(
  table: HTMLTableElement,
  key: Key,
  end: boolean,
  global: boolean,
): Key | null {
  const rows = bodyRows(table);
  const edgeRow = end ? rows[rows.length - 1] : rows[0];
  if (isRow(key)) return edgeRow ?? null;
  const row = global ? edgeRow : rowOf(key);
  if (!row) return null;
  return cellAt(row, end ? row.cells.length - 1 : 0);
}

function pageHeight(table: HTMLTableElement): number {
  for (let el = table.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.clientHeight) {
      return el.clientHeight;
    }
  }
  return window.innerHeight;
}

/** React Aria's getKeyPageBelow/Above over row rectangles. */
function keyPage(table: HTMLTableElement, key: Key, dir: -1 | 1) {
  const height = pageHeight(table);
  let rect = rowOf(key).getBoundingClientRect();
  let current: Key = key;
  if (dir > 0) {
    const limit = rect.top + height;
    while (rect.bottom < limit) {
      const next = keyVertical(table, current, 1);
      if (!next) break;
      current = next;
      rect = rowOf(next).getBoundingClientRect();
    }
  } else {
    const limit = Math.max(0, rect.bottom - height);
    while (rect.top > limit) {
      const next = keyVertical(table, current, -1);
      if (!next) break;
      current = next;
      rect = rowOf(next).getBoundingClientRect();
    }
  }
  return current;
}

function scrollIntoView(el: HTMLElement) {
  if (typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function focusKey(key: Key, childFocus: ChildFocus = "first") {
  const children = isRow(key) ? [] : focusableChildren(key);
  const target =
    (childFocus === "last" ? children[children.length - 1] : children[0]) ??
    key;
  target.focus();
  scrollIntoView(target);
}

function isTabbable(el: HTMLElement, root: Element): boolean {
  return el.tabIndex >= 0 && !isHidden(el, root) && !isSkipped(el, root);
}

/** The last tabbable element inside `table`, in document order. */
function lastTabbable(table: HTMLTableElement): HTMLElement | null {
  const tabbable = Array.from(
    table.querySelectorAll<HTMLElement>(FOCUSABLE),
  ).filter((el) => isTabbable(el, table));
  return tabbable[tabbable.length - 1] ?? null;
}

/** Wire roving focus onto one table element; returns the detach function. */
function attach(
  table: HTMLTableElement,
  options: RefObject<GridNavigationOptions | undefined>,
): () => void {
  let focusedKey: Key | null = null;
  let lastFocused: HTMLElement | null = null;
  let tab: { shift: boolean; event: KeyboardEvent } | null = null;
  /** A Tab the browser will act on; a cancelled one (an editor committing
   *  and moving on) moves focus in code, which is not Tab entry. */
  const tabbing = () => (tab && !tab.event.defaultPrevented ? tab : null);
  let leaving = false;

  const allKeys = (): Key[] => [
    ...bodyRows(table),
    ...Array.from(table.rows).flatMap((row) => Array.from(row.cells)),
  ];

  const syncTabIndexes = () => {
    if (focusedKey && !focusedKey.isConnected) focusedKey = null;
    const want = focusedKey ? -1 : 0;
    if (table.tabIndex !== want) table.tabIndex = want;
    for (const key of allKeys()) {
      const tabIndex = key === focusedKey ? 0 : -1;
      if (key.tabIndex !== tabIndex || !key.hasAttribute("tabindex")) {
        key.tabIndex = tabIndex;
      }
    }
    // Skipped controls are reached from their cell, never by Tab.
    for (const el of table.querySelectorAll<HTMLElement>(
      `${SKIP} :is(${FOCUSABLE}), ${SKIP}:is(${FOCUSABLE})`,
    )) {
      if (el.tabIndex !== -1) el.tabIndex = -1;
    }
  };

  const setFocusedKey = (key: Key) => {
    if (focusedKey === key) return;
    if (focusedKey) focusedKey.tabIndex = -1;
    focusedKey = key;
    key.tabIndex = 0;
    table.tabIndex = -1;
  };

  const enter = (shift: boolean) => {
    if (lastFocused?.isConnected && table.contains(lastFocused)) {
      lastFocused.focus();
      return;
    }
    const rows = bodyRows(table);
    const row = shift ? rows[rows.length - 1] : rows[0];
    if (row) focusKey(row);
  };

  const onFocusIn = (event: FocusEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || !table.contains(target)) return;
    if (leaving) return;
    const from = event.relatedTarget;
    const entering = !(from instanceof Node && table.contains(from));

    if (target === table) {
      if (entering) enter(tabbing()?.shift ?? false);
      return;
    }
    const tabbed = tabbing();
    if (entering && tabbed) {
      const restore =
        lastFocused?.isConnected && table.contains(lastFocused)
          ? lastFocused
          : null;
      if (restore && restore !== target) {
        restore.focus();
        return;
      }
      if (!restore) {
        enter(tabbed.shift);
        return;
      }
    }

    const key = keyOf(table, target);
    if (!key) return;
    if (target === key && !isRow(key)) {
      // A focused cell hands focus to its first control, unless focus is
      // coming back out of that cell (which would trap it).
      const child = focusableChildren(key)[0];
      if (child && !(from instanceof Node && key.contains(from))) {
        child.focus();
        return;
      }
    }
    // Resize mode belongs to its cell: re-entry lands on the cell.
    lastFocused = isSkipped(target, key) ? key : target;
    setFocusedKey(key);
  };

  /**
   * React Aria's Tab handling: move focus to the grid's edge and let the
   * browser's default Tab carry it out. Forwards, that edge is the last
   * tabbable inside the grid; backwards, it is the table itself. Neither
   * transit focus becomes the focused key.
   */
  const leave = (shift: boolean) => {
    const active = table.ownerDocument.activeElement;
    let edge: HTMLElement | null = table;
    if (!shift) {
      edge = lastTabbable(table);
      const settled =
        edge?.contains(active) &&
        active instanceof HTMLElement &&
        isTabbable(active, table);
      if (settled) return;
    }
    if (!edge) return;
    leaving = true;
    try {
      edge.focus();
    } finally {
      leaving = false;
    }
  };

  /** Up/Down, Home/End and PageUp/PageDown; undefined when not a nav key. */
  const keyFor = (event: KeyboardEvent, key: Key): Key | null | undefined => {
    const global = event.ctrlKey || event.metaKey;
    switch (event.key) {
      case "ArrowUp":
        return keyVertical(table, key, -1);
      case "ArrowDown":
        return keyVertical(table, key, 1);
      case "Home":
        return keyHomeEnd(table, key, false, global);
      case "End":
        return keyHomeEnd(table, key, true, global);
      case "PageUp":
        return keyPage(table, key, -1);
      case "PageDown":
        return keyPage(table, key, 1);
      default:
        return undefined;
    }
  };

  /** ArrowLeft/Right: walk the cell's controls first, then the next key. */
  const horizontal = (target: HTMLElement, key: Key, dir: -1 | 1) => {
    if (!isRow(key)) {
      const children = focusableChildren(key);
      const next = children[children.indexOf(target) + dir];
      if (target !== key && next) {
        next.focus();
        scrollIntoView(next);
        return;
      }
      if (target === key && dir > 0 && children[0]) {
        focusKey(key, "first");
        return;
      }
    }
    const next = keyHorizontal(table, key, dir);
    if (next) focusKey(next, dir > 0 ? "first" : "last");
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (event.defaultPrevented) return;
    if (!(target instanceof HTMLElement) || !table.contains(target)) return;
    if (isSkipped(target, table)) {
      skippedKeyDown(event, target);
      return;
    }
    if (isEditorTarget(target)) return;

    if (event.key === "Tab") {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      leave(event.shiftKey);
      return;
    }
    const key = keyOf(table, target);
    if (!key) return;

    if (event.altKey) {
      const onHeaderMove = options.current?.onHeaderMove;
      const header = !isRow(key) && isHeaderRow(table, rowOf(key));
      if (
        onHeaderMove &&
        header &&
        (event.key === "ArrowLeft" || event.key === "ArrowRight")
      ) {
        event.preventDefault();
        // A resizer in resize mode must not also take the arrow.
        event.stopPropagation();
        onHeaderMove(
          key as HTMLTableCellElement,
          event.key === "ArrowLeft" ? -1 : 1,
        );
      }
      return;
    }
    if (event.metaKey && event.key.startsWith("Arrow")) return;

    if (event.key === "Enter") {
      const onActivateRow = options.current?.onActivateRow;
      const row = rowOf(key);
      const resizer =
        target === key && isHeaderRow(table, row) ? skippedControl(key) : null;
      if (resizer) {
        event.preventDefault();
        resizer.focus();
        return;
      }
      if (target === key && onActivateRow && !isHeaderRow(table, row)) {
        event.preventDefault();
        onActivateRow(row);
      }
      return;
    }

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      horizontal(target, key, event.key === "ArrowLeft" ? -1 : 1);
    } else {
      const next = keyFor(event, key);
      if (next === undefined) return;
      if (next && next !== key) focusKey(next);
    }
    event.preventDefault();
    event.stopPropagation();
  };

  /** Resize mode: Escape/Enter/Tab return to the cell (Tab then leaves the
   *  grid as usual); Alt+Arrow moves the header; everything else is the
   *  control's own. */
  const skippedKeyDown = (event: KeyboardEvent, target: HTMLElement) => {
    const key = keyOf(table, target);
    if (!key || isRow(key)) return;
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      key.focus();
      return;
    }
    if (event.key === "Tab") {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      key.focus();
      leave(event.shiftKey);
      return;
    }
    const onHeaderMove = options.current?.onHeaderMove;
    if (
      event.altKey &&
      onHeaderMove &&
      isHeaderRow(table, rowOf(key)) &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      event.stopPropagation();
      onHeaderMove(key, event.key === "ArrowLeft" ? -1 : 1);
    }
  };

  const onDocumentKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "Tab") return;
    tab = { shift: event.shiftKey, event };
    setTimeout(() => {
      tab = null;
    });
  };

  const observer = new MutationObserver((records) => {
    const structural = records.some(
      (record) =>
        record.target instanceof HTMLTableElement ||
        record.target instanceof HTMLTableSectionElement ||
        record.target instanceof HTMLTableRowElement,
    );
    if (structural) syncTabIndexes();
  });

  syncTabIndexes();
  observer.observe(table, { childList: true, subtree: true });
  table.addEventListener("focusin", onFocusIn);
  table.addEventListener("keydown", onKeyDown);
  const doc = table.ownerDocument;
  doc.addEventListener("keydown", onDocumentKeyDown, true);

  return () => {
    observer.disconnect();
    table.removeEventListener("focusin", onFocusIn);
    table.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("keydown", onDocumentKeyDown, true);
  };
}

/**
 * Roving focus and arrow-key navigation for the `<table role="grid">` in
 * `ref`. Re-attaches when the table element changes (a keyed remount).
 */
export function useGridNavigation(
  ref: RefObject<HTMLTableElement | null>,
  options?: GridNavigationOptions,
): void {
  const optionsRef = useRef(options);
  useLayoutEffect(() => {
    optionsRef.current = options;
  });

  const attached = useRef<{
    table: HTMLTableElement;
    detach: () => void;
  } | null>(null);

  useEffect(() => {
    const table = ref.current;
    if (attached.current?.table === table) return;
    attached.current?.detach();
    attached.current = table
      ? { table, detach: attach(table, optionsRef) }
      : null;
  });

  useEffect(
    () => () => {
      attached.current?.detach();
      attached.current = null;
    },
    [],
  );
}

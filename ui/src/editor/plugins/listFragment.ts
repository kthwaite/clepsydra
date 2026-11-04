import {
  type Descendant,
  Editor,
  Node,
  Path,
  type Point,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { isListElement, isListItem } from "#/editor/plugins/listUtils";
import { makeParagraph } from "#/editor/schema/elements/paragraph";

type Item = SlateElement & { type: "list-item"; checked?: boolean | null };

const isLine = (node: Descendant | undefined): node is SlateElement =>
  SlateElement.isElement(node) &&
  (node.type === "paragraph" || node.type === "heading");

/**
 * Insert a fragment holding a top-level list so it keeps the list shape.
 *
 * Slate's default knows nothing about lists: it drops raw items where the caret
 * paragraph sits, and replaces an empty item's paragraph with a whole list. Here
 * the first pasted line joins the text before the caret, later pasted items
 * become siblings of the caret's item, and the text after the caret joins the
 * last pasted line. Other fragments, and carets outside a paragraph or heading,
 * go to `fallback`.
 */
export function insertListFragment(
  editor: Editor,
  fragment: Descendant[],
  fallback: (fragment: Descendant[]) => void,
): void {
  const blocks = prepareFragment(fragment);
  if (!editor.selection || !blocks.some(isListElement)) {
    fallback(blocks);
    return;
  }

  // Deleted before the rest, so it normalizes: a delete can leave an item with no
  // children, and Slate's next delete cannot find the document's end until it is
  // repaired. No selecting here: a selection op first would merge the whole paste
  // into the previous undo batch.
  const range = Editor.unhangRange(editor, editor.selection);
  const isCaret = Range.isCollapsed(range);
  if (!isCaret) {
    // Slate's own insertFragment refuses a selection ending in a void.
    if (Editor.void(editor, { at: Range.end(range) })) return;
    Transforms.delete(editor);
  }
  const point = isCaret ? range.anchor : editor.selection?.anchor;
  if (!point) {
    fallback(blocks);
    return;
  }
  Editor.withoutNormalizing(editor, () => {
    const line = Editor.above(editor, {
      at: point,
      match: (n) => isLine(n as Descendant),
    });
    if (!line || Editor.void(editor, { at: point })) {
      fallback(blocks);
      return;
    }
    const linePath = line[1];
    const parent = Node.get(editor, Path.parent(linePath));
    const isLead = isListItem(parent) && linePath[linePath.length - 1] === 0;
    const hostEmpty =
      Editor.isStart(editor, point, linePath) &&
      Editor.isEnd(editor, point, linePath);

    // One plain item merges inline, unless it would fill an empty item.
    if (isOnePlainItem(blocks) && !(isLead && hostEmpty)) {
      fallback(blocks);
      return;
    }
    if (isLead) {
      insertIntoItem(editor, point, linePath, blocks);
    } else if (hostEmpty) {
      fallback(blocks);
    } else {
      insertAfterLine(editor, point, linePath, blocks);
    }
  });
}

// ---------------------------------------------------------------------------
// Fragment clean-up
// ---------------------------------------------------------------------------

function prepareFragment(fragment: Descendant[]): Descendant[] {
  return structuredClone(fragment).map(prepareNode);
}

function prepareNode(node: Descendant): Descendant {
  if (!SlateElement.isElement(node)) return node;
  if (!isListElement(node)) {
    return { ...node, children: node.children.map(prepareNode) } as Descendant;
  }
  const items = node.children.flatMap((child) =>
    isListItem(child) ? unwrapLeadlessItem(child) : [child],
  );
  // A list that was only a wrapper round an inner list takes the inner type.
  const only = node.children.length === 1 ? node.children[0] : undefined;
  const inner =
    isListItem(only) && isListElement(only.children[0])
      ? only.children[0].type
      : node.type;
  return { ...node, type: inner, children: items } as Descendant;
}

/**
 * `Node.fragment` keeps the ancestors of a selection that starts in a nested
 * item, leaving outer items with a list and no line of their own. Their inner
 * items stand in for them. A childless item, as the parser gives for a bare
 * marker, gets its line.
 */
function unwrapLeadlessItem(item: Item): SlateElement[] {
  if (item.children.length === 0) {
    return [{ ...item, children: [makeParagraph({})] } as SlateElement];
  }
  const children = item.children.map(prepareNode);
  const [first, ...rest] = children;
  if (!isListElement(first)) return [{ ...item, children } as SlateElement];
  const inner = first.children as SlateElement[];
  if (rest.length > 0 && inner.length > 0) {
    const last = inner[inner.length - 1];
    inner[inner.length - 1] = {
      ...last,
      children: [...last.children, ...rest],
    } as SlateElement;
  }
  return inner;
}

function isOnePlainItem(blocks: Descendant[]): boolean {
  if (blocks.length !== 1) return false;
  const [list] = blocks;
  if (!isListElement(list) || list.children.length !== 1) return false;
  const [item] = list.children;
  return (
    isListItem(item) && item.children.length === 1 && isLine(item.children[0])
  );
}

// ---------------------------------------------------------------------------
// Placement
// ---------------------------------------------------------------------------

/** Where the caret belongs among nodes about to be inserted. */
interface CaretSpot {
  /** Path of the final block, relative to the inserted nodes. */
  path: number[];
  /** Index of the last pasted text child in it, or null: use the block's edge. */
  textChild: number | null;
}

/**
 * Join `tail` (the text after the caret) to the last pasted line, or give it a
 * paragraph when the last pasted block cannot take text.
 */
function placeTail(nodes: Descendant[], tail: Descendant[]): CaretSpot {
  let container = nodes;
  let path: number[] = [];
  for (;;) {
    const index = container.length - 1;
    const last = container[index];
    path = [...path, index];
    if (
      SlateElement.isElement(last) &&
      (isListElement(last) || isListItem(last))
    ) {
      container = last.children as Descendant[];
      continue;
    }
    if (SlateElement.isElement(last) && last.type === "paragraph") {
      const children = last.children as Descendant[];
      if (!Text.isText(children[children.length - 1])) {
        children.push({ text: "" });
      }
      const textChild = children.length - 1;
      children.push(...tail);
      return { path, textChild };
    }
    if (tail.length === 0) return { path, textChild: null };
    container.push(makeParagraph({ children: tail as never }));
    return { path: [...path.slice(0, -1), index + 1], textChild: null };
  }
}

function selectCaret(
  editor: Editor,
  base: Path,
  spot: CaretSpot,
  hasTail: boolean,
) {
  const [first, ...rest] = spot.path;
  const start = base[base.length - 1];
  const path = [...base.slice(0, -1), start + first, ...rest];
  if (spot.textChild !== null) {
    Transforms.select(editor, Editor.end(editor, [...path, spot.textChild]));
  } else {
    Transforms.select(
      editor,
      hasTail ? Editor.start(editor, path) : Editor.end(editor, path),
    );
  }
}

/** Cut the text after `point` out of the line and return its inline nodes. */
function takeTail(editor: Editor, point: Point, linePath: Path): Descendant[] {
  if (Editor.isEnd(editor, point, linePath)) return [];
  const range = { anchor: point, focus: Editor.end(editor, linePath) };
  let node = { children: Node.fragment(editor, range) } as {
    children: Descendant[];
  };
  for (let depth = 0; depth < linePath.length; depth++) {
    node = node.children[0] as unknown as { children: Descendant[] };
  }
  const tail = node.children;
  Transforms.delete(editor, { at: range });
  return structuredClone(tail);
}

function insertInlines(editor: Editor, linePath: Path, inlines: Descendant[]) {
  if (inlines.length === 0) return;
  Transforms.insertNodes(editor, inlines, {
    at: Editor.end(editor, linePath),
    match: (n) => Text.isText(n) || Editor.isInline(editor, n as SlateElement),
    mode: "highest",
    select: false,
  });
}

function withClosingText(inlines: Descendant[]): Descendant[] {
  const last = inlines[inlines.length - 1];
  return last === undefined || Text.isText(last)
    ? inlines
    : [...inlines, { text: "" }];
}

/**
 * The caret's line is an item's own line. The first pasted line joins it, the
 * first pasted item's other blocks follow it in that item, and later pasted
 * items become its siblings. The item's own later blocks and kids end up after
 * everything pasted, under the last pasted item.
 */
function insertIntoItem(
  editor: Editor,
  point: Point,
  linePath: Path,
  blocks: Descendant[],
): void {
  const itemPath = Path.parent(linePath);
  const headEmpty = Editor.isStart(editor, point, linePath);
  const tail = takeTail(editor, point, linePath);

  const extras: Descendant[] = [];
  const items: Item[] = [];
  let current = extras;
  let inlines: Descendant[] = [];
  let firstItem: Item | null = null;
  let consumed = false;
  for (const block of blocks) {
    if (!isListElement(block)) {
      if (consumed || !isLine(block)) current.push(block);
      else inlines = block.children;
      consumed = true;
      continue;
    }
    for (const item of block.children as Item[]) {
      if (consumed) {
        items.push(item);
        current = item.children as Descendant[];
        continue;
      }
      consumed = true;
      firstItem = item;
      const [lead, ...rest] = item.children;
      if (isLine(lead)) {
        inlines = lead.children;
        current.push(...rest);
      } else {
        current.push(...item.children);
      }
    }
  }

  insertInlines(editor, linePath, withClosingText(inlines));
  if (headEmpty && firstItem) adoptItemData(editor, itemPath, firstItem);

  const item = Node.get(editor, itemPath) as SlateElement;
  const hostRest = item.children.length - 1;
  const extrasAt = [...itemPath, 1];
  const itemsAt = Path.next(itemPath);
  const pasted = items.length > 0 ? items : extras;
  const spot = pasted.length > 0 ? placeTail(pasted, tail) : null;
  const base = items.length > 0 ? itemsAt : extrasAt;

  if (extras.length > 0) {
    Transforms.insertNodes(editor, extras, { at: extrasAt, select: false });
  }
  if (items.length > 0) {
    Transforms.insertNodes(editor, items, { at: itemsAt, select: false });
  }

  // The item's own later blocks now read after everything pasted.
  const restStart = 1 + extras.length;
  let ownerPath = itemPath;
  if (items.length > 0) {
    const lastIndex = itemsAt[itemsAt.length - 1] + items.length - 1;
    ownerPath = [...itemsAt.slice(0, -1), lastIndex];
    const ownerSize = (Node.get(editor, ownerPath) as SlateElement).children
      .length;
    for (let i = 0; i < hostRest; i++) {
      Transforms.moveNodes(editor, {
        at: [...itemPath, restStart],
        to: [...ownerPath, ownerSize + i],
      });
    }
    joinListsAt(editor, ownerPath, ownerSize);
  } else if (hostRest > 0) {
    joinListsAt(editor, itemPath, restStart);
  }

  if (spot) {
    selectCaret(editor, base, spot, tail.length > 0);
  } else {
    Transforms.select(editor, Editor.end(editor, linePath));
  }
}

/** The line was empty, so the pasted item's data has nothing to contradict. */
function adoptItemData(editor: Editor, itemPath: Path, pasted: Item): void {
  const { type: _type, children: _children, ...data } = pasted;
  const host = Node.get(editor, itemPath) as unknown as Record<string, unknown>;
  const missing = Object.fromEntries(
    Object.entries(data).filter(([key]) => host[key] == null),
  );
  if (Object.keys(missing).length > 0) {
    Transforms.setNodes(editor, missing as Partial<SlateElement>, {
      at: itemPath,
    });
  }
}

/** Merge the same-type lists either side of child `index` of the item. */
function joinListsAt(editor: Editor, itemPath: Path, index: number): void {
  if (index === 0) return;
  const item = Node.get(editor, itemPath) as SlateElement;
  const before = item.children[index - 1];
  const after = item.children[index];
  if (
    !isListElement(before) ||
    !isListElement(after) ||
    before.type !== after.type
  ) {
    return;
  }
  const size = before.children.length;
  for (let i = 0; i < after.children.length; i++) {
    Transforms.moveNodes(editor, {
      at: [...itemPath, index, 0],
      to: [...itemPath, index - 1, size + i],
    });
  }
  Transforms.removeNodes(editor, { at: [...itemPath, index] });
}

/**
 * The caret's line is a plain block: a paragraph, heading, or an item's later
 * paragraph. With text before the caret, the first pasted line joins it and the
 * rest follows as blocks. With none, the pasted blocks replace the line.
 */
function insertAfterLine(
  editor: Editor,
  point: Point,
  linePath: Path,
  blocks: Descendant[],
): void {
  const headEmpty = Editor.isStart(editor, point, linePath);
  const tail = takeTail(editor, point, linePath);

  let inlines: Descendant[] = [];
  let after = blocks;
  const [first, ...others] = blocks;
  if (!headEmpty && isLine(first)) {
    inlines = first.children;
    after = others;
  } else if (!headEmpty && isListElement(first)) {
    const [firstItem, ...moreItems] = first.children as Item[];
    const [lead, ...rest] = firstItem.children;
    if (isLine(lead)) {
      inlines = lead.children;
      after = [
        ...rest,
        ...(moreItems.length > 0
          ? [{ ...first, children: moreItems } as Descendant]
          : []),
        ...others,
      ];
    }
  }

  insertInlines(editor, linePath, withClosingText(inlines));
  const at = Path.next(linePath);
  const spot = after.length > 0 ? placeTail(after, tail) : null;
  if (after.length > 0) {
    Transforms.insertNodes(editor, after, { at, select: false });
  }
  if (headEmpty) Transforms.removeNodes(editor, { at: linePath });
  if (spot) {
    selectCaret(editor, headEmpty ? linePath : at, spot, tail.length > 0);
  } else {
    Transforms.select(editor, Editor.end(editor, linePath));
  }
}

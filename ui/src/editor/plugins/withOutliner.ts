import {
  Editor,
  Node,
  Path,
  Point,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { isListElement, isListItem } from "#/editor/plugins/listUtils";

/**
 * Slate plugin that allows list-items to contain mixed content (text + nested
 * lists). Without this override, Slate's default normalization merges block
 * children into adjacent text nodes, destroying nested list structure.
 */
export function withOutliner(editor: Editor): Editor {
  const { deleteBackward } = editor;

  editor.deleteBackward = (unit) => {
    const { selection } = editor;
    if (selection && Range.isCollapsed(selection)) {
      const itemEntry = Editor.above(editor, {
        match: (n) => isListItem(n),
      });
      if (itemEntry) {
        const [, itemPath] = itemEntry;
        const itemStart = Editor.start(editor, itemPath);
        if (Point.equals(selection.anchor, itemStart)) {
          if (isItemNested(editor, itemPath)) {
            outdentListItem(editor);
          } else {
            unwrapListItemToParagraph(editor, itemPath);
          }
          return;
        }
      }
    }
    deleteBackward(unit);
  };

  return editor;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Whether the given list-item is nested inside another list-item.
 * Structure: list-item > list > list-item.
 */
function isItemNested(editor: Editor, itemPath: Path): boolean {
  const parentListPath = Path.parent(itemPath);
  if (parentListPath.length === 0) return false;
  const grandparentPath = Path.parent(parentListPath);
  try {
    const grandparent = Node.get(editor, grandparentPath);
    return isListItem(grandparent);
  } catch {
    return false;
  }
}

/**
 * Convert a top-level list-item into a paragraph at the same depth as the
 * containing list, preserving its text content. Splits the list if the item
 * is in the middle, so items above and below remain in valid lists.
 */
function unwrapListItemToParagraph(editor: Editor, itemPath: Path): void {
  const parentListPath = Path.parent(itemPath);
  const parentList = Node.get(editor, parentListPath);
  if (!isListElement(parentList)) return;

  const itemIndex = itemPath[itemPath.length - 1];
  const siblingCount = parentList.children.length;

  // Snapshot the inline children of the item's first paragraph (these become
  // the new paragraph's children). Nested lists are lifted after the new
  // paragraph so Backspace never silently deletes child items.
  const itemNode = Node.get(editor, itemPath);
  if (!SlateElement.isElement(itemNode)) return;
  let paragraphChildren: any[] = [{ text: "" }];
  let foundParagraph = false;
  for (const child of itemNode.children) {
    if (SlateElement.isElement(child) && child.type === "paragraph") {
      paragraphChildren = JSON.parse(JSON.stringify(child.children));
      foundParagraph = true;
      break;
    }
  }
  if (!foundParagraph) {
    // Fall back to the item's own inline children, skipping nested lists.
    const inline = itemNode.children.filter(
      (c) => !(SlateElement.isElement(c) && isListElement(c)),
    );
    if (inline.length > 0) {
      paragraphChildren = JSON.parse(JSON.stringify(inline));
    }
  }
  const nestedLists = itemNode.children
    .filter((child) => SlateElement.isElement(child) && isListElement(child))
    .map((child) => JSON.parse(JSON.stringify(child)) as SlateElement);

  Editor.withoutNormalizing(editor, () => {
    // Capture trailing siblings before mutation so we can rebuild a list below.
    const trailingItems: SlateElement[] = [];
    for (let i = itemIndex + 1; i < siblingCount; i++) {
      const sibPath = [...parentListPath, i];
      trailingItems.push(
        JSON.parse(JSON.stringify(Node.get(editor, sibPath))) as SlateElement,
      );
    }

    // Remove trailing siblings (back-to-front to keep paths stable) and the item itself.
    for (let i = siblingCount - 1; i >= itemIndex; i--) {
      Transforms.removeNodes(editor, { at: [...parentListPath, i] });
    }

    let insertAt: Path;
    if (itemIndex === 0) {
      // The item was first — replace the now-empty list with the paragraph.
      try {
        const remaining = Node.get(editor, parentListPath);
        if (isListElement(remaining) && remaining.children.length === 0) {
          Transforms.removeNodes(editor, { at: parentListPath });
        }
      } catch {
        // Already removed
      }
      insertAt = parentListPath;
    } else {
      // Items remain above; place the paragraph after the (shrunken) list.
      insertAt = Path.next(parentListPath);
    }

    Transforms.insertNodes(
      editor,
      { type: "paragraph", children: paragraphChildren } as any,
      { at: insertAt },
    );

    let nextInsertAt = Path.next(insertAt);
    for (const nestedList of nestedLists) {
      Transforms.insertNodes(editor, nestedList as any, { at: nextInsertAt });
      nextInsertAt = Path.next(nextInsertAt);
    }

    if (trailingItems.length > 0) {
      Transforms.insertNodes(
        editor,
        { type: parentList.type, children: trailingItems } as any,
        { at: nextInsertAt },
      );
    }

    // Place the cursor at the start of the new paragraph.
    Transforms.select(editor, Editor.start(editor, insertAt));
  });
}

// ---------------------------------------------------------------------------
// Operation helpers
// ---------------------------------------------------------------------------

/**
 * Find the nearest list-item ancestor of the current selection.
 * Returns [node, path] or undefined if not inside a list item.
 */
function findListItem(
  editor: Editor,
): [SlateElement & { type: "list-item" }, Path] | undefined {
  const { selection } = editor;
  if (!selection) return undefined;

  const match = Editor.above(editor, {
    at: selection,
    match: (n) => isListItem(n),
  });

  if (!match) return undefined;
  return match as [SlateElement & { type: "list-item" }, Path];
}

// ---------------------------------------------------------------------------
// Indent
// ---------------------------------------------------------------------------

/**
 * Indent the current list item, making it a child of the previous sibling.
 *
 * If the previous sibling already has a nested list, the current item is
 * appended to that list. Otherwise a new list (matching the parent type)
 * is created inside the previous sibling.
 */
export function indentListItem(editor: Editor): void {
  const entry = findListItem(editor);
  if (!entry) return;

  const [, itemPath] = entry;

  // Must have a previous sibling
  const itemIndex = itemPath[itemPath.length - 1];
  if (itemIndex === 0) return;

  const prevSiblingPath = Path.previous(itemPath);
  const prevSibling = Node.get(editor, prevSiblingPath);
  if (!isListItem(prevSibling)) return;

  // Determine the parent list type so the nested list matches
  const parentPath = Path.parent(itemPath);
  const parentNode = Node.get(editor, parentPath);
  const listType = isListElement(parentNode)
    ? parentNode.type
    : "bulleted-list";

  // Check if the previous sibling already has a nested list as its last child
  const prevChildren = prevSibling.children;
  const lastChild = prevChildren[prevChildren.length - 1];

  Editor.withoutNormalizing(editor, () => {
    if (isListElement(lastChild)) {
      // Move the current item to the end of the existing nested list
      const nestedListPath = [...prevSiblingPath, prevChildren.length - 1];
      const nestedList = Node.get(editor, nestedListPath);
      if (!SlateElement.isElement(nestedList)) return;
      const destPath = [...nestedListPath, nestedList.children.length];
      Transforms.moveNodes(editor, { at: itemPath, to: destPath });
    } else {
      // Clone the item, remove it, then insert a nested list into the
      // previous sibling. We clone first because removeNodes invalidates
      // the node reference.
      const itemNode = JSON.parse(
        JSON.stringify(Node.get(editor, itemPath)),
      ) as SlateElement;
      Transforms.removeNodes(editor, { at: itemPath });

      // Insert a new list containing the cloned item as last child
      // of the previous sibling
      const insertIdx = prevChildren.length;
      Transforms.insertNodes(
        editor,
        {
          type: listType,
          children: [itemNode],
        } as SlateElement,
        { at: [...prevSiblingPath, insertIdx] },
      );
    }
  });
}

// ---------------------------------------------------------------------------
// Outdent
// ---------------------------------------------------------------------------

/**
 * Outdent the current list item, lifting it out of its nested list.
 *
 * The item is moved to be a sibling of the grandparent list-item,
 * inserted right after it.
 */
export function outdentListItem(editor: Editor): void {
  const entry = findListItem(editor);
  if (!entry) return;

  const [, itemPath] = entry;

  // The item must be inside a nested list: list-item > list > list-item
  // Path length >= 3 (e.g. [0, 0, 1, 0] = root-list > li > nested-list > li)
  if (itemPath.length < 3) return;

  // Parent should be a list element
  const parentListPath = Path.parent(itemPath);
  const parentList = Node.get(editor, parentListPath);
  if (!isListElement(parentList)) return;

  // Grandparent should be a list-item
  const grandparentPath = Path.parent(parentListPath);
  const grandparent = Node.get(editor, grandparentPath);
  if (!isListItem(grandparent)) return;

  const itemIndex = itemPath[itemPath.length - 1];
  const siblingCount = parentList.children.length;

  Editor.withoutNormalizing(editor, () => {
    // If there are siblings after the current item in the nested list,
    // they become a sub-list of the item being outdented.
    if (itemIndex < siblingCount - 1) {
      const listType = parentList.type;

      // Clone trailing items and remove them from the nested list
      const trailingItems: SlateElement[] = [];
      for (let i = siblingCount - 1; i > itemIndex; i--) {
        const trailPath = [...parentListPath, i];
        trailingItems.unshift(
          JSON.parse(JSON.stringify(Node.get(editor, trailPath))),
        );
        Transforms.removeNodes(editor, { at: trailPath });
      }

      // Insert them as a nested list inside the current item
      const currentItem = Node.get(editor, itemPath);
      if (!SlateElement.isElement(currentItem)) return;
      const insertIdx = currentItem.children.length;

      Transforms.insertNodes(
        editor,
        {
          type: listType,
          children: trailingItems,
        } as SlateElement,
        { at: [...itemPath, insertIdx] },
      );
    }

    // Move the current item out, after the grandparent
    const destPath = Path.next(grandparentPath);
    Transforms.moveNodes(editor, { at: itemPath, to: destPath });

    // Clean up: if the parent list is now empty, remove it
    try {
      const remaining = Node.get(editor, parentListPath);
      if (isListElement(remaining) && remaining.children.length === 0) {
        Transforms.removeNodes(editor, { at: parentListPath });
      }
    } catch {
      // Parent list already removed by normalization
    }
  });
}

// ---------------------------------------------------------------------------
// Move up / down
// ---------------------------------------------------------------------------

/**
 * Move the current list item (with children) up, swapping with the previous
 * sibling.
 */
export function moveBlockUp(editor: Editor): void {
  const entry = findListItem(editor);
  if (!entry) return;

  const [, itemPath] = entry;
  const itemIndex = itemPath[itemPath.length - 1];
  if (itemIndex === 0) return;

  const prevPath = Path.previous(itemPath);
  Transforms.moveNodes(editor, { at: itemPath, to: prevPath });
}

/**
 * Move the current list item (with children) down, swapping with the next
 * sibling.
 */
export function moveBlockDown(editor: Editor): void {
  const entry = findListItem(editor);
  if (!entry) return;

  const [, itemPath] = entry;

  // Check if there is a next sibling
  const parentPath = Path.parent(itemPath);
  const parent = Node.get(editor, parentPath);
  if (!SlateElement.isElement(parent)) return;

  const itemIndex = itemPath[itemPath.length - 1];
  if (itemIndex >= parent.children.length - 1) return;

  // Move to after the next sibling (which effectively swaps them)
  const afterNextPath = Path.next(Path.next(itemPath));
  Transforms.moveNodes(editor, { at: itemPath, to: afterNextPath });
}

// ---------------------------------------------------------------------------
// Toggle checkbox
// ---------------------------------------------------------------------------

/**
 * Toggle the checkbox state on the current list item.
 *
 * Cycling: undefined/null -> false (create task) -> true (done) -> false (undo)
 */
export function toggleCheckbox(editor: Editor): void {
  const entry = findListItem(editor);
  if (!entry) return;

  const [node, path] = entry;
  const current = node.checked;

  let next: boolean;
  if (current === undefined || current === null) {
    next = false;
  } else if (current === false) {
    next = true;
  } else {
    next = false;
  }

  Transforms.setNodes(editor, { checked: next }, { at: path });
}

import {
  Editor,
  Node,
  Path,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { isListElement, isListItem } from "#/editor/plugins/listUtils";

/**
 * Get the text content of the first paragraph child of a list-item.
 * Returns the trimmed text, or undefined if no paragraph child.
 */
function getFirstParagraphText(item: SlateElement): string | undefined {
  for (const child of item.children) {
    if (SlateElement.isElement(child) && child.type === "paragraph") {
      return Node.string(child).trim();
    }
  }
  return undefined;
}

/**
 * Check whether a list-item is nested inside another list-item.
 * Structure: list-item > list > list-item — if the parent list
 * itself has a list-item ancestor, we are nested.
 */
function isNested(editor: Editor, itemPath: Path): boolean {
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
 * Handle Enter key inside a list-item. Returns true if handled, false otherwise.
 *
 * Cases:
 * 1. Non-empty item, cursor at end -> insert new sibling item
 * 2. Non-empty item, cursor mid-text -> split text across two items
 * 3. Empty item + nested -> outdent one level
 * 4. Empty item + top-level -> exit list (unwrap to paragraph)
 */
export function tryListContinuation(
  editor: Editor,
  { historyBatch = true }: { historyBatch?: boolean } = {},
): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;

  // Find the nearest list-item ancestor
  const itemEntry = Editor.above(editor, {
    match: (n) => isListItem(n),
  });
  if (!itemEntry) return false;

  const [itemNode, itemPath] = itemEntry as [
    SlateElement & { type: "list-item"; checked?: boolean | null },
    Path,
  ];

  // Get first paragraph text to determine if "empty"
  const firstText = getFirstParagraphText(itemNode);
  const isEmpty = firstText === undefined || firstText === "";

  // Find the parent list
  const parentListPath = Path.parent(itemPath);
  const parentList = Node.get(editor, parentListPath);
  if (!isListElement(parentList)) return false;

  const batchOp = (fn: () => void) => {
    if (historyBatch) {
      HistoryEditor.withNewBatch(editor as HistoryEditor, fn);
    } else {
      fn();
    }
  };

  if (isEmpty) {
    if (isNested(editor, itemPath)) {
      // LC-03: Empty nested item -> outdent
      batchOp(() => {
        Editor.withoutNormalizing(editor, () => {
          const itemIndex = itemPath[itemPath.length - 1];
          const siblingCount = parentList.children.length;

          // If there are siblings after this item, they become a sub-list of the outdented item
          if (itemIndex < siblingCount - 1) {
            const trailingItems: SlateElement[] = [];
            for (let i = siblingCount - 1; i > itemIndex; i--) {
              const trailPath = [...parentListPath, i];
              trailingItems.unshift(
                JSON.parse(JSON.stringify(Node.get(editor, trailPath))),
              );
              Transforms.removeNodes(editor, { at: trailPath });
            }
            const currentItem = Node.get(editor, itemPath);
            if (SlateElement.isElement(currentItem)) {
              Transforms.insertNodes(
                editor,
                {
                  type: parentList.type,
                  children: trailingItems,
                } as SlateElement,
                { at: [...itemPath, currentItem.children.length] },
              );
            }
          }

          // Move item after the grandparent list-item
          const grandparentPath = Path.parent(parentListPath);
          const destPath = Path.next(grandparentPath);
          Transforms.moveNodes(editor, { at: itemPath, to: destPath });

          // Clean up empty parent list
          try {
            const remaining = Node.get(editor, parentListPath);
            if (isListElement(remaining) && remaining.children.length === 0) {
              Transforms.removeNodes(editor, { at: parentListPath });
            }
          } catch {
            // Already removed
          }
        });
      });
      return true;
    }

    // LC-04: Empty top-level item -> exit list, unwrap to paragraph
    batchOp(() => {
      Editor.withoutNormalizing(editor, () => {
        // Remove the empty item from the list
        Transforms.removeNodes(editor, { at: itemPath });

        // Insert a paragraph after the list
        const afterListPath = Path.next(parentListPath);
        Transforms.insertNodes(
          editor,
          {
            type: "paragraph",
            children: [{ text: "" }],
          } as SlateElement,
          { at: afterListPath },
        );

        // Move cursor to the new paragraph
        Transforms.select(editor, {
          anchor: { path: [...afterListPath, 0], offset: 0 },
          focus: { path: [...afterListPath, 0], offset: 0 },
        });

        // If the list is now empty, remove it
        try {
          const remaining = Node.get(editor, parentListPath);
          if (isListElement(remaining) && remaining.children.length === 0) {
            Transforms.removeNodes(editor, { at: parentListPath });
          }
        } catch {
          // Already removed
        }
      });
    });
    return true;
  }

  // Non-empty item: find the paragraph and cursor position
  const paragraphEntry = Editor.above(editor, {
    match: (n) => SlateElement.isElement(n) && n.type === "paragraph",
  });
  if (!paragraphEntry) return false;

  const [, paragraphPath] = paragraphEntry;

  // Get the text node and offset
  const point = selection.anchor;
  const textNode = Node.get(editor, point.path);
  if (!Text.isText(textNode)) return false;

  const fullText = textNode.text;
  const offset = point.offset;
  const isAtEnd = Editor.isEnd(editor, point, paragraphPath);

  // Check if this is a task item
  const isTask = itemNode.checked !== undefined && itemNode.checked !== null;

  if (isAtEnd) {
    // LC-01/LC-02: Cursor at end of non-empty text -> new sibling item
    batchOp(() => {
      Editor.withoutNormalizing(editor, () => {
        const newItem: any = {
          type: "list-item",
          children: [
            {
              type: "paragraph",
              children: [{ text: "" }],
            },
          ],
        };
        if (isTask) {
          newItem.checked = false;
        }

        const nextItemPath = Path.next(itemPath);
        Transforms.insertNodes(editor, newItem as SlateElement, {
          at: nextItemPath,
        });

        // Move cursor to the new item's paragraph text
        Transforms.select(editor, {
          anchor: { path: [...nextItemPath, 0, 0], offset: 0 },
          focus: { path: [...nextItemPath, 0, 0], offset: 0 },
        });
      });
    });
    return true;
  }

  // LC-05: Cursor mid-text -> split
  batchOp(() => {
    Editor.withoutNormalizing(editor, () => {
      const afterText = fullText.slice(offset);

      // Update current text node to only contain text before cursor
      Transforms.delete(editor, {
        at: {
          anchor: { path: point.path, offset },
          focus: { path: point.path, offset: fullText.length },
        },
      });

      // Create new item with the remaining text
      const newItem: any = {
        type: "list-item",
        children: [
          {
            type: "paragraph",
            children: [{ text: afterText }],
          },
        ],
      };
      if (isTask) {
        newItem.checked = false;
      }

      const nextItemPath = Path.next(itemPath);
      Transforms.insertNodes(editor, newItem as SlateElement, {
        at: nextItemPath,
      });

      // Move cursor to start of new item
      Transforms.select(editor, {
        anchor: { path: [...nextItemPath, 0, 0], offset: 0 },
        focus: { path: [...nextItemPath, 0, 0], offset: 0 },
      });
    });
  });
  return true;
}

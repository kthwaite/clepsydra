import {
  Editor,
  Node,
  Path,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})$/;
const NUMBERED_LIST_RE = /^(\d+)\.$/;
const BULLETED_LIST_RE = /^[-*]$/;
const BLOCKQUOTE_RE = /^>$/;
const TASK_RE = /^\[([ xX])\]$/;
const CODE_FENCE_RE = /^```(\w*)$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ListType = "bulleted-list" | "numbered-list";

function isBlock(node: unknown): node is SlateElement {
  return SlateElement.isElement(node) && !Editor.isEditor(node as any);
}

/**
 * Get the current block entry where the cursor sits.
 * Returns [element, path] or undefined.
 */
function getCurrentBlock(editor: Editor): [SlateElement, Path] | undefined {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return undefined;

  const [match] = Editor.nodes(editor, {
    at: selection,
    match: (n) => isBlock(n),
    mode: "lowest",
  });

  return match as [SlateElement, Path] | undefined;
}

/**
 * Get the text content of a block's first text node and verify cursor is at end.
 */
function getBlockTriggerText(
  editor: Editor,
  blockEntry: [SlateElement, Path],
): string | undefined {
  const [block, blockPath] = blockEntry;
  const { selection } = editor;
  if (!selection) return undefined;

  // The text node must be the first (and ideally only meaningful) child
  const firstChild = block.children[0];
  if (!firstChild || !("text" in firstChild)) return undefined;

  const textPath = [...blockPath, 0];
  const offset = selection.anchor.offset;

  // Cursor must be at the end of the text
  if (
    selection.anchor.path.join(",") !== textPath.join(",") ||
    offset !== firstChild.text.length
  ) {
    return undefined;
  }

  return firstChild.text;
}

// ---------------------------------------------------------------------------
// List merge: merge with adjacent same-type list
// ---------------------------------------------------------------------------

function mergeWithAdjacentList(
  editor: Editor,
  listPath: Path,
  listType: ListType,
): void {
  const index = listPath[listPath.length - 1];

  // Check previous sibling
  if (index > 0) {
    const prevPath = Path.previous(listPath);
    try {
      const prevNode = Node.get(editor, prevPath);
      if (
        SlateElement.isElement(prevNode) &&
        (prevNode as any).type === listType
      ) {
        // Move all children of our new list into the previous list
        const ourNode = Node.get(editor, listPath);
        if (!SlateElement.isElement(ourNode)) return;
        const count = ourNode.children.length;
        for (let i = count - 1; i >= 0; i--) {
          Transforms.moveNodes(editor, {
            at: [...listPath, i],
            to: [...prevPath, (prevNode as any).children.length],
          });
        }
        // Remove the now-empty list wrapper
        Transforms.removeNodes(editor, { at: listPath });
        return;
      }
    } catch {
      // no previous sibling
    }
  }
}

// ---------------------------------------------------------------------------
// tryBlockTransform — space-triggered
// ---------------------------------------------------------------------------

/**
 * Attempt a block-level transform. Called when space is pressed.
 * Returns true if a transform was applied, false otherwise.
 */
export function tryBlockTransform(editor: Editor): boolean {
  const blockEntry = getCurrentBlock(editor);
  if (!blockEntry) return false;

  const [block, blockPath] = blockEntry;
  const blockType = (block as any).type;

  // Task promotion: paragraph inside a list-item
  if (blockType === "paragraph" && blockPath.length >= 2) {
    const parentPath = Path.parent(blockPath);
    try {
      const parent = Node.get(editor, parentPath);
      if (
        SlateElement.isElement(parent) &&
        (parent as any).type === "list-item"
      ) {
        return tryTaskPromotion(editor, blockEntry, parentPath);
      }
    } catch {
      // not in a list item
    }
  }

  // Block transforms only apply to top-level(ish) paragraphs
  if (blockType !== "paragraph") return false;

  const text = getBlockTriggerText(editor, blockEntry);
  if (text === undefined) return false;

  // Heading: # through ######
  const headingMatch = text.match(HEADING_RE);
  if (headingMatch) {
    const level = headingMatch[1].length as 1 | 2 | 3 | 4 | 5 | 6;
    applyWithBatch(editor, () => {
      // Delete the trigger text
      Transforms.delete(editor, {
        at: {
          anchor: { path: [...blockPath, 0], offset: 0 },
          focus: { path: [...blockPath, 0], offset: text.length },
        },
      });
      // Convert paragraph to heading
      Transforms.setNodes(editor, { type: "heading", level } as any, {
        at: blockPath,
      });
    });
    return true;
  }

  // Numbered list: 1.
  if (NUMBERED_LIST_RE.test(text)) {
    return applyListTransform(editor, blockEntry, "numbered-list");
  }

  // Bulleted list: - or *
  if (BULLETED_LIST_RE.test(text)) {
    return applyListTransform(editor, blockEntry, "bulleted-list");
  }

  // Blockquote: >
  if (BLOCKQUOTE_RE.test(text)) {
    applyWithBatch(editor, () => {
      // Delete the trigger text
      Transforms.delete(editor, {
        at: {
          anchor: { path: [...blockPath, 0], offset: 0 },
          focus: { path: [...blockPath, 0], offset: text.length },
        },
      });
      // Wrap the paragraph in a blockquote
      Transforms.wrapNodes(
        editor,
        { type: "blockquote", children: [] } as any,
        { at: blockPath },
      );
    });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// List transform helper
// ---------------------------------------------------------------------------

function applyListTransform(
  editor: Editor,
  blockEntry: [SlateElement, Path],
  listType: ListType,
): boolean {
  const [, blockPath] = blockEntry;
  const text = getBlockTriggerText(editor, blockEntry);
  if (text === undefined) return false;

  applyWithBatch(editor, () => {
    // Delete the trigger text
    Transforms.delete(editor, {
      at: {
        anchor: { path: [...blockPath, 0], offset: 0 },
        focus: { path: [...blockPath, 0], offset: text.length },
      },
    });
    // Wrap paragraph in list-item, then in list
    // Step 1: wrap paragraph in list-item
    Transforms.wrapNodes(editor, { type: "list-item", children: [] } as any, {
      at: blockPath,
    });
    // Step 2: wrap list-item in list
    Transforms.wrapNodes(editor, { type: listType, children: [] } as any, {
      at: blockPath,
    });

    // Merge with adjacent same-type list
    mergeWithAdjacentList(editor, blockPath, listType);
  });

  return true;
}

// ---------------------------------------------------------------------------
// Task promotion helper
// ---------------------------------------------------------------------------

function tryTaskPromotion(
  editor: Editor,
  blockEntry: [SlateElement, Path],
  listItemPath: Path,
): boolean {
  const text = getBlockTriggerText(editor, blockEntry);
  if (text === undefined) return false;

  const taskMatch = text.match(TASK_RE);
  if (!taskMatch) return false;

  const checked = taskMatch[1] !== " ";
  const [, blockPath] = blockEntry;

  applyWithBatch(editor, () => {
    // Delete the trigger text
    Transforms.delete(editor, {
      at: {
        anchor: { path: [...blockPath, 0], offset: 0 },
        focus: { path: [...blockPath, 0], offset: text.length },
      },
    });
    // Set checked on the list-item
    Transforms.setNodes(editor, { checked } as any, { at: listItemPath });
  });

  return true;
}

// ---------------------------------------------------------------------------
// tryThematicBreak — immediate on `-` key
// ---------------------------------------------------------------------------

/**
 * Attempt thematic break transform. Called when `-` is typed and the
 * text becomes `---`. Returns true if applied.
 */
export function tryThematicBreak(editor: Editor): boolean {
  const blockEntry = getCurrentBlock(editor);
  if (!blockEntry) return false;

  const [block, blockPath] = blockEntry;
  if ((block as any).type !== "paragraph") return false;

  const text = getBlockTriggerText(editor, blockEntry);
  if (text !== "--") return false;

  applyWithBatch(editor, () => {
    // Delete all text in the paragraph
    Transforms.delete(editor, {
      at: {
        anchor: { path: [...blockPath, 0], offset: 0 },
        focus: { path: [...blockPath, 0], offset: 2 },
      },
    });
    // Convert to thematic-break
    Transforms.setNodes(editor, { type: "thematic-break" } as any, {
      at: blockPath,
    });
    // Insert a trailing paragraph after
    Transforms.insertNodes(
      editor,
      { type: "paragraph", children: [{ text: "" }] } as any,
      { at: Path.next(blockPath) },
    );
    // Move selection to the new paragraph
    Transforms.select(editor, {
      anchor: { path: [...Path.next(blockPath), 0], offset: 0 },
      focus: { path: [...Path.next(blockPath), 0], offset: 0 },
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// tryCodeFence — Enter-triggered
// ---------------------------------------------------------------------------

/**
 * Attempt code fence transform. Called from insertBreak when Enter is
 * pressed. Detects ```lang pattern and converts to code-block.
 * Returns true if applied.
 */
export function tryCodeFence(editor: Editor): boolean {
  const blockEntry = getCurrentBlock(editor);
  if (!blockEntry) return false;

  const [block, blockPath] = blockEntry;
  if ((block as any).type !== "paragraph") return false;

  const text = getBlockTriggerText(editor, blockEntry);
  if (text === undefined) return false;

  const match = text.match(CODE_FENCE_RE);
  if (!match) return false;

  const language = match[1] || undefined;

  applyWithBatch(editor, () => {
    // Delete all text
    Transforms.delete(editor, {
      at: {
        anchor: { path: [...blockPath, 0], offset: 0 },
        focus: { path: [...blockPath, 0], offset: text.length },
      },
    });
    // Convert to code-block
    Transforms.setNodes(editor, { type: "code-block", language } as any, {
      at: blockPath,
    });
  });

  return true;
}

// ---------------------------------------------------------------------------
// Undo batching helper
// ---------------------------------------------------------------------------

function applyWithBatch(editor: Editor, fn: () => void): void {
  const histEditor = editor as unknown as HistoryEditor;
  if (typeof HistoryEditor.withNewBatch === "function") {
    HistoryEditor.withNewBatch(histEditor, () => {
      Editor.withoutNormalizing(editor, fn);
    });
  } else {
    Editor.withoutNormalizing(editor, fn);
  }
}

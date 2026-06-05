import {
  Editor,
  Node,
  Path,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { applyBlockConversion } from "#/editor/transforms/blockConversions";

// ---------------------------------------------------------------------------
// Pattern definitions
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})$/;
const NUMBERED_LIST_RE = /^(\d+)\.$/;
const BULLETED_LIST_RE = /^[-*]$/;
const BLOCKQUOTE_RE = /^>$/;
const TASK_RE = /^\[([ xX]?)\]$/;
const CODE_FENCE_RE = /^```(\w*)$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Range spanning the leading trigger text in a block's first text node. */
function triggerRange(blockPath: Path, len: number) {
  return {
    anchor: { path: [...blockPath, 0], offset: 0 },
    focus: { path: [...blockPath, 0], offset: len },
  };
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
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "heading", level },
    });
    return true;
  }

  // Numbered list: 1.
  if (NUMBERED_LIST_RE.test(text)) {
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "numbered-list" },
    });
    return true;
  }

  // Bulleted list: - or *
  if (BULLETED_LIST_RE.test(text)) {
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "bulleted-list" },
    });
    return true;
  }

  // Task list: [], [ ], [x], [X]
  const taskMatch = text.match(TASK_RE);
  if (taskMatch) {
    const checked = taskMatch[1] === "x" || taskMatch[1] === "X";
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "task", checked },
    });
    return true;
  }

  // Blockquote: >
  if (BLOCKQUOTE_RE.test(text)) {
    applyBlockConversion(editor, {
      at: blockPath,
      deleteRange: triggerRange(blockPath, text.length),
      conversion: { type: "blockquote" },
    });
    return true;
  }

  return false;
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

  const inner = taskMatch[1];
  const checked = inner === "x" || inner === "X";
  const [, blockPath] = blockEntry;

  HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
    Editor.withoutNormalizing(editor, () => {
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

  applyBlockConversion(editor, {
    at: blockPath,
    deleteRange: triggerRange(blockPath, 2),
    conversion: { type: "thematic-break" },
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

  applyBlockConversion(editor, {
    at: blockPath,
    deleteRange: triggerRange(blockPath, text.length),
    conversion: { type: "code-block", language },
  });

  return true;
}

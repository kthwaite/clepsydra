import {
  Editor,
  Element as SlateElement,
  type Path,
  Transforms,
} from "slate";
import type { ConversationTurnElement } from "../schema/types";
import type { ConversationRole } from "./marker";

export interface InsertConversationTurnOptions {
  after?: Path;
  role?: ConversationRole;
  uuidFactory?: () => string;
}

function topLevelConversationTurn(
  editor: Editor,
  path: Path,
): ConversationTurnElement | null {
  if (path.length !== 1) return null;
  const index = path[0];
  if (
    !Number.isInteger(index) ||
    index < 0 ||
    index >= editor.children.length
  ) {
    return null;
  }
  const node = editor.children[index];
  return SlateElement.isElement(node) && node.type === "conversation-turn"
    ? node
    : null;
}

export function insertConversationTurn(
  editor: Editor,
  options: InsertConversationTurnOptions = {},
): void {
  let insertionIndex = editor.children.length;
  if (options.after) {
    if (!topLevelConversationTurn(editor, options.after)) return;
    insertionIndex = options.after[0] + 1;
  }

  const uuid = options.uuidFactory
    ? options.uuidFactory()
    : crypto.randomUUID();
  const turn: ConversationTurnElement = {
    type: "conversation-turn",
    role: options.role ?? "assistant",
    source: `local:${uuid}`,
    origin: "local",
    children: [{ type: "paragraph", children: [{ text: "" }] }],
  };
  Transforms.insertNodes(editor, turn, { at: [insertionIndex] });
}

export function setConversationRole(
  editor: Editor,
  path: Path,
  role: ConversationRole,
): void {
  if (!topLevelConversationTurn(editor, path)) return;
  Transforms.setNodes(editor, { role }, { at: path });
}

export function moveConversationTurn(
  editor: Editor,
  path: Path,
  direction: -1 | 1,
): void {
  const turn = topLevelConversationTurn(editor, path);
  if (!turn) return;

  const currentIndex = path[0];
  let adjacentIndex = currentIndex + direction;
  while (adjacentIndex >= 0 && adjacentIndex < editor.children.length) {
    const adjacent = editor.children[adjacentIndex];
    if (
      SlateElement.isElement(adjacent) &&
      adjacent.type === "conversation-turn"
    ) {
      break;
    }
    adjacentIndex += direction;
  }
  if (adjacentIndex < 0 || adjacentIndex >= editor.children.length) return;

  const lowerIndex = Math.min(currentIndex, adjacentIndex);
  const upperIndex = Math.max(currentIndex, adjacentIndex);

  Editor.withoutNormalizing(editor, () => {
    Transforms.moveNodes(editor, {
      at: [lowerIndex],
      to: [upperIndex],
    });
    Transforms.moveNodes(editor, {
      at: [upperIndex - 1],
      to: [lowerIndex],
    });
  });
}

export function removeConversationTurn(editor: Editor, path: Path): void {
  if (!topLevelConversationTurn(editor, path)) return;
  Editor.withoutNormalizing(editor, () => {
    Transforms.removeNodes(editor, { at: path });
    if (editor.children.length === 0) {
      Transforms.insertNodes(
        editor,
        { type: "paragraph", children: [{ text: "" }] },
        { at: [0] },
      );
    }
  });
}

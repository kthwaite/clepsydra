import {
  Editor,
  Path,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";

/**
 * Deleting from an empty block into an adjacent block void (a Base embed, a
 * generated region, a thematic break) removes the empty block, so the void
 * moves into its place. Slate's default widens the delete range over the whole
 * void and removes it instead, leaving the empty block behind.
 */
export function withBlockVoidDeletion(editor: Editor): Editor {
  const { deleteBackward, deleteForward } = editor;

  editor.deleteBackward = (unit) => {
    if (removeEmptyBlockBesideVoid(editor, "backward")) return;
    deleteBackward(unit);
  };

  editor.deleteForward = (unit) => {
    if (removeEmptyBlockBesideVoid(editor, "forward")) return;
    deleteForward(unit);
  };

  return editor;
}

function removeEmptyBlockBesideVoid(
  editor: Editor,
  direction: "backward" | "forward",
): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;

  const blockEntry = Editor.above<SlateElement>(editor, {
    at: selection,
    match: (n) => SlateElement.isElement(n) && Editor.isBlock(editor, n),
    mode: "lowest",
  });
  if (!blockEntry) return false;
  const [block, blockPath] = blockEntry;
  if (editor.isVoid(block) || !Editor.isEmpty(editor, block)) return false;

  if (direction === "backward" && !Path.hasPrevious(blockPath)) return false;
  const voidPath =
    direction === "forward" ? Path.next(blockPath) : Path.previous(blockPath);
  if (!Editor.hasPath(editor, voidPath)) return false;
  const [neighbour] = Editor.node(editor, voidPath);
  if (
    !SlateElement.isElement(neighbour) ||
    !Editor.isBlock(editor, neighbour) ||
    !editor.isVoid(neighbour)
  ) {
    return false;
  }

  Editor.withoutNormalizing(editor, () => {
    Transforms.removeNodes(editor, { at: blockPath });
    // Forward: the void slides up into the removed block's path.
    const landing = direction === "forward" ? blockPath : voidPath;
    Transforms.select(
      editor,
      direction === "forward"
        ? Editor.start(editor, landing)
        : Editor.end(editor, landing),
    );
  });
  return true;
}

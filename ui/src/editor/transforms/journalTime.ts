import {
  Editor,
  type Path,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { makeJournalTime } from "#/editor/schema/elements/journalTime";

const emptyParagraph = () => ({
  type: "paragraph" as const,
  children: [{ text: "" }],
});

export function formatJournalTime(date = new Date()): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function insertJournalTimeHeading(
  editor: Editor,
  now = new Date(),
  startNewBatch = true,
): void {
  if (!editor.selection) return;
  const topPath: Path = [editor.selection.anchor.path[0]];
  if (!Editor.hasPath(editor, topPath)) return;
  const [topNode] = Editor.node(editor, topPath);
  const replace =
    SlateElement.isElement(topNode) &&
    topNode.type === "paragraph" &&
    Editor.string(editor, topPath) === "";
  const insertionIndex = topPath[0] + (replace ? 0 : 1);

  const insert = () => {
    Editor.withoutNormalizing(editor, () => {
      if (replace) Transforms.removeNodes(editor, { at: topPath });
      Transforms.insertNodes(
        editor,
        [makeJournalTime({ time: formatJournalTime(now) }), emptyParagraph()],
        { at: [insertionIndex] },
      );
      Transforms.select(editor, { path: [insertionIndex + 1, 0], offset: 0 });
    });
  };
  if (startNewBatch) {
    HistoryEditor.withNewBatch(editor as HistoryEditor, insert);
  } else {
    insert();
  }
}

export function removeJournalTimeHeading(editor: Editor, at: Path): boolean {
  if (!Editor.hasPath(editor, at)) return false;
  const [node] = Editor.node(editor, at);
  if (!SlateElement.isElement(node) || node.type !== "journal-time")
    return false;
  Transforms.removeNodes(editor, { at });
  if (editor.children.length === 0) {
    Transforms.insertNodes(editor, emptyParagraph(), { at: [0] });
    Transforms.select(editor, { path: [0, 0], offset: 0 });
  }
  return true;
}

export function handleJournalTimeHeadingDeletion(
  editor: Editor,
  direction: "backward" | "forward",
): boolean {
  const { selection } = editor;
  if (!selection || !Range.isCollapsed(selection)) return false;

  const topPath: Path = [selection.anchor.path[0]];
  if (!Editor.hasPath(editor, topPath)) return false;
  const [topNode] = Editor.node(editor, topPath);
  if (SlateElement.isElement(topNode) && topNode.type === "journal-time") {
    return removeJournalTimeHeading(editor, topPath);
  }

  const atEdge =
    direction === "backward"
      ? Editor.isStart(editor, selection.anchor, topPath)
      : Editor.isEnd(editor, selection.anchor, topPath);
  if (!atEdge) return false;

  const siblingIndex = topPath[0] + (direction === "backward" ? -1 : 1);
  if (siblingIndex < 0 || siblingIndex >= editor.children.length) return false;
  const siblingPath: Path = [siblingIndex];
  const [sibling] = Editor.node(editor, siblingPath);
  if (!SlateElement.isElement(sibling) || sibling.type !== "journal-time") {
    return false;
  }

  Transforms.select(editor, { path: [siblingIndex, 0], offset: 0 });
  return true;
}

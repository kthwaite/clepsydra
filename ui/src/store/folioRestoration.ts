import { Editor, type Path, type Point, Text } from "slate";

export type TextPointSnapshot = {
  path: Path;
  offset: number;
  text: string;
};

export type FolioRestoration = {
  tabId: string;
  path: string;
  revision: string;
  scrollTop: number;
  anchor: TextPointSnapshot | null;
  focus: TextPointSnapshot | null;
};

const MAX_RECORDS = 16;
const records = new Map<string, FolioRestoration>();

function clonePoint(point: TextPointSnapshot | null): TextPointSnapshot | null {
  return point
    ? { path: [...point.path], offset: point.offset, text: point.text }
    : null;
}

function cloneRecord(record: FolioRestoration): FolioRestoration {
  return {
    ...record,
    anchor: clonePoint(record.anchor),
    focus: clonePoint(record.focus),
  };
}

export function saveFolioRestoration(record: FolioRestoration): void {
  records.delete(record.tabId);
  records.set(record.tabId, cloneRecord(record));

  if (records.size <= MAX_RECORDS) return;
  const oldestTabId = records.keys().next().value;
  if (oldestTabId !== undefined) records.delete(oldestTabId);
}

export function readFolioRestoration(
  tabId: string,
  path: string,
): FolioRestoration | null {
  const record = records.get(tabId);
  if (!record || record.path !== path) return null;
  return cloneRecord(record);
}

export function clearFolioRestoration(tabId: string): void {
  records.delete(tabId);
}

export function snapshotTextPoint(
  editor: Editor,
  point: Point,
): TextPointSnapshot | null {
  try {
    const [node] = Editor.node(editor, point.path);
    if (
      !Text.isText(node) ||
      point.offset < 0 ||
      point.offset > node.text.length
    ) {
      return null;
    }
    return { path: [...point.path], offset: point.offset, text: node.text };
  } catch {
    return null;
  }
}

export function validateTextPointSnapshot(
  editor: Editor,
  snapshot: TextPointSnapshot,
  requireTextMatch = true,
): Point | null {
  try {
    const [node] = Editor.node(editor, snapshot.path);
    if (
      !Text.isText(node) ||
      (requireTextMatch && node.text !== snapshot.text) ||
      snapshot.offset < 0 ||
      snapshot.offset > node.text.length
    ) {
      return null;
    }
    return { path: [...snapshot.path], offset: snapshot.offset };
  } catch {
    return null;
  }
}

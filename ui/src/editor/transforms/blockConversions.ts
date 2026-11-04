import {
  Editor,
  Node,
  Path,
  Point,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { isListItem, type ListType } from "#/editor/plugins/listUtils";
import { makeBlockquote } from "#/editor/schema/elements/blockquote";
import {
  makeBulletedList,
  makeListItem,
  makeNumberedList,
} from "#/editor/schema/elements/list";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import { insertJournalTimeHeading } from "#/editor/transforms/journalTime";
import type { CodeBlockElement, ListItemElement } from "#/editor/types";

export type BlockConversion =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "bulleted-list" }
  | { type: "numbered-list" }
  | { type: "task"; checked?: boolean }
  | { type: "blockquote" }
  | { type: "code-block"; language?: string }
  | { type: "thematic-break" }
  | { type: "journal-time"; withDate?: boolean };

export interface ApplyBlockConversionOptions {
  /** Path of the paragraph block to convert. */
  at: Path;
  /** Trigger marker or `/query` text to remove before converting. */
  deleteRange?: Range;
  conversion: BlockConversion;
}

/**
 * Convert the paragraph at `opts.at` into the target block, deleting the
 * trigger/query text first. Runs as a single undo batch. Lists always merge
 * with an adjacent same-type sibling list.
 */
export function applyBlockConversion(
  editor: Editor,
  { at, deleteRange, conversion }: ApplyBlockConversionOptions,
): void {
  withBatch(editor, () => {
    if (deleteRange) {
      Transforms.delete(editor, { at: deleteRange });
    }

    switch (conversion.type) {
      case "heading":
        Transforms.setNodes(
          editor,
          { type: "heading", level: conversion.level },
          { at },
        );
        break;
      case "bulleted-list":
      case "numbered-list": {
        const item = itemLedBy(editor, at);
        if (item) setItemListType(editor, item, conversion.type);
        else wrapInList(editor, at, conversion.type);
        break;
      }
      case "task": {
        const checked = conversion.checked ?? false;
        const item = itemLedBy(editor, at);
        if (!item) wrapInList(editor, at, "bulleted-list", checked);
        else if ((Node.get(editor, item) as ListItemElement).checked == null) {
          Transforms.setNodes(editor, { checked }, { at: item });
        }
        break;
      }
      case "blockquote":
        Transforms.wrapNodes(editor, makeBlockquote({}), { at });
        break;
      case "code-block": {
        const props: Partial<CodeBlockElement> = { type: "code-block" };
        if (conversion.language) props.language = conversion.language;
        Transforms.setNodes(editor, props, { at });
        break;
      }
      case "journal-time":
        insertJournalTimeHeading(editor, new Date(), false, {
          withDate: conversion.withDate,
        });
        break;
      case "thematic-break": {
        Transforms.setNodes(editor, { type: "thematic-break" }, { at });
        const nextPath = Path.next(at);
        Transforms.insertNodes(editor, makeParagraph({}), { at: nextPath });
        Transforms.select(editor, {
          anchor: { path: [...nextPath, 0], offset: 0 },
          focus: { path: [...nextPath, 0], offset: 0 },
        });
        break;
      }
    }
  });
}

/** Format selected lines as a list without flattening their inline content. */
export function applySelectionList(editor: Editor, listType: ListType): void {
  if (!editor.selection || Range.isCollapsed(editor.selection)) return;

  withBatch(editor, () => {
    const isTextBlock = (node: Node) =>
      SlateElement.isElement(node) &&
      (node.type === "paragraph" || node.type === "heading");
    const blocks = Array.from(Editor.nodes(editor, { match: isTextBlock }));

    // Work backwards so splitting a later line never invalidates earlier paths.
    for (const [block, path] of blocks.reverse()) {
      // A soft line inside a list item is part of that item.
      if (isListItem(Node.get(editor, Path.parent(path)))) continue;
      for (const [leaf, leafPath] of Array.from(Node.texts(block)).reverse()) {
        for (let offset = leaf.text.lastIndexOf("\n"); offset >= 0; ) {
          const point = { path: [...path, ...leafPath], offset };
          Transforms.delete(editor, {
            at: { anchor: point, focus: { ...point, offset: offset + 1 } },
          });
          Transforms.splitNodes(editor, {
            at: point,
            match: isTextBlock,
            always: true,
          });
          offset = leaf.text.lastIndexOf("\n", offset - 1);
          if (point.offset === 0) break;
        }
      }
    }

    if (!editor.selection) return;
    const [start, end] = Range.edges(editor.selection);
    const paths = Array.from(Editor.nodes(editor, { match: isTextBlock }))
      .filter(
        ([, path]) =>
          Point.compare(Editor.start(editor, path), end) < 0 &&
          Point.compare(Editor.end(editor, path), start) >= 0,
      )
      .map(([, path]) => Editor.pathRef(editor, path));
    try {
      for (const ref of paths) {
        const path = ref.current;
        if (!path) continue;
        if ((Node.get(editor, path) as SlateElement).type === "heading") {
          Transforms.setNodes(editor, { type: "paragraph" }, { at: path });
          Transforms.unsetNodes(editor, "level", { at: path });
        }
        // A line that is already an item keeps the item, and everything on it.
        const item = itemLedBy(editor, path);
        if (item) setItemListType(editor, item, listType);
        else wrapInList(editor, path, listType);
      }
    } finally {
      for (const ref of paths) ref.unref();
    }
  });
}

/** The list item whose own line is the paragraph at `at`, if there is one. */
function itemLedBy(editor: Editor, at: Path): Path | null {
  if (at.length < 2 || at[at.length - 1] !== 0) return null;
  const parentPath = Path.parent(at);
  const parent = Node.get(editor, parentPath);
  return SlateElement.isElement(parent) && parent.type === "list-item"
    ? parentPath
    : null;
}

/** Put one item in a list of `listType`, splitting its list around it if needed. */
function setItemListType(editor: Editor, item: Path, listType: ListType): void {
  const list = Node.get(editor, Path.parent(item));
  if (SlateElement.isElement(list) && list.type === listType) return;
  const ref = Editor.pathRef(editor, item);
  Transforms.liftNodes(editor, { at: item });
  const lifted = ref.unref();
  if (!lifted) return;
  Transforms.wrapNodes(
    editor,
    listType === "bulleted-list" ? makeBulletedList({}) : makeNumberedList({}),
    { at: lifted },
  );
  mergeWithAdjacentList(editor, lifted, listType);
}

function wrapInList(
  editor: Editor,
  at: Path,
  listType: ListType,
  checked?: boolean,
): void {
  const listPath = [...at];
  Transforms.wrapNodes(
    editor,
    makeListItem(
      checked === undefined ? { children: [] } : { children: [], checked },
    ),
    { at },
  );
  Transforms.wrapNodes(
    editor,
    listType === "bulleted-list" ? makeBulletedList({}) : makeNumberedList({}),
    { at },
  );
  mergeWithAdjacentList(editor, listPath, listType);
}

/** Merge the list at `listPath` with its same-type sibling lists on both sides. */
function mergeWithAdjacentList(
  editor: Editor,
  listPath: Path,
  listType: ListType,
): void {
  const sameType = (path: Path) => {
    if (!Editor.hasPath(editor, path)) return false;
    const node = Node.get(editor, path);
    return SlateElement.isElement(node) && node.type === listType;
  };

  let merged = listPath;
  if (listPath[listPath.length - 1] > 0) {
    const prevPath = Path.previous(listPath);
    if (sameType(prevPath)) {
      appendListItems(editor, listPath, prevPath);
      merged = prevPath;
    }
  }
  const nextPath = Path.next(merged);
  if (sameType(nextPath)) appendListItems(editor, nextPath, merged);
}

/** Move every item of the list at `from` to the end of `to`, removing `from`. */
function appendListItems(editor: Editor, from: Path, to: Path): void {
  const fromNode = Node.get(editor, from) as SlateElement;
  const toNode = Node.get(editor, to) as SlateElement;
  const count = fromNode.children.length;
  const offset = toNode.children.length;
  // Always move the current first child: each move shrinks the source from the
  // front, so index 0 is the next item every iteration and order is preserved.
  for (let i = 0; i < count; i++) {
    Transforms.moveNodes(editor, {
      at: [...from, 0],
      to: [...to, offset + i],
    });
  }
  Transforms.removeNodes(editor, { at: from });
}

function withBatch(editor: Editor, fn: () => void): void {
  if (typeof HistoryEditor.withNewBatch === "function") {
    HistoryEditor.withNewBatch(editor, () => {
      Editor.withoutNormalizing(editor, fn);
    });
  } else {
    Editor.withoutNormalizing(editor, fn);
  }
}

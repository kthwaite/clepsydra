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
import { isListElement, type ListType } from "#/editor/plugins/listUtils";
import { makeBlockquote } from "#/editor/schema/elements/blockquote";
import {
  makeBulletedList,
  makeListItem,
  makeNumberedList,
} from "#/editor/schema/elements/list";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import { insertJournalTimeHeading } from "#/editor/transforms/journalTime";
import type { CodeBlockElement } from "#/editor/types";

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
        wrapInList(editor, at, "bulleted-list");
        break;
      case "numbered-list":
        wrapInList(editor, at, "numbered-list");
        break;
      case "task":
        wrapInList(editor, at, "bulleted-list", conversion.checked ?? false);
        break;
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
    // Split existing list containers at the selection, leaving other items alone.
    Transforms.unwrapNodes(editor, {
      match: isListElement,
      split: true,
    });
    Transforms.unwrapNodes(editor, {
      match: (node) =>
        SlateElement.isElement(node) && node.type === "list-item",
      split: true,
    });

    const isTextBlock = (node: Node) =>
      SlateElement.isElement(node) &&
      (node.type === "paragraph" || node.type === "heading");
    const blocks = Array.from(Editor.nodes(editor, { match: isTextBlock }));

    // Work backwards so splitting a later line never invalidates earlier paths.
    for (const [block, path] of blocks.reverse()) {
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
        Transforms.setNodes(editor, { type: "paragraph" }, { at: path });
        Transforms.unsetNodes(editor, "level", { at: path });
        wrapInList(editor, path, listType);
      }
    } finally {
      for (const ref of paths) ref.unref();
    }
  });
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

/** Merge the list at `listPath` into an immediately-preceding same-type list. */
function mergeWithAdjacentList(
  editor: Editor,
  listPath: Path,
  listType: ListType,
): void {
  const index = listPath[listPath.length - 1];
  if (index > 0) {
    const prevPath = Path.previous(listPath);
    try {
      const prevNode = Node.get(editor, prevPath);
      if (SlateElement.isElement(prevNode) && prevNode.type === listType) {
        const ourNode = Node.get(editor, listPath);
        if (!SlateElement.isElement(ourNode)) return;
        const count = ourNode.children.length;
        // Always move the current first child: each move shrinks our list from
        // the front, so source index 0 is the next item every iteration. This
        // preserves original order (moving from the tail would reverse it).
        for (let i = 0; i < count; i++) {
          Transforms.moveNodes(editor, {
            at: [...listPath, 0],
            to: [...prevPath, prevNode.children.length],
          });
        }
        Transforms.removeNodes(editor, { at: listPath });
        return;
      }
    } catch {
      // no previous sibling
    }
  }
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

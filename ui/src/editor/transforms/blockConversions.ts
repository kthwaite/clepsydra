import {
  Editor,
  Node,
  Path,
  type Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import type { ListType } from "#/editor/plugins/listUtils";
import { makeBlockquote } from "#/editor/schema/elements/blockquote";
import {
  makeBulletedList,
  makeListItem,
  makeNumberedList,
} from "#/editor/schema/elements/list";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import { insertJournalTimeHeading } from "#/editor/transforms/journalTime";

export type BlockConversion =
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6 }
  | { type: "bulleted-list" }
  | { type: "numbered-list" }
  | { type: "task"; checked?: boolean }
  | { type: "blockquote" }
  | { type: "code-block"; language?: string }
  | { type: "thematic-break" }
  | { type: "journal-time" };

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
          { type: "heading", level: conversion.level } as any,
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
        const props: Record<string, unknown> = { type: "code-block" };
        if (conversion.language) props.language = conversion.language;
        Transforms.setNodes(editor, props as any, { at });
        break;
      }
      case "journal-time":
        insertJournalTimeHeading(editor, new Date(), false);
        break;
      case "thematic-break": {
        Transforms.setNodes(editor, { type: "thematic-break" } as any, { at });
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
      if (
        SlateElement.isElement(prevNode) &&
        (prevNode as any).type === listType
      ) {
        const ourNode = Node.get(editor, listPath);
        if (!SlateElement.isElement(ourNode)) return;
        const count = ourNode.children.length;
        // Always move the current first child: each move shrinks our list from
        // the front, so source index 0 is the next item every iteration. This
        // preserves original order (moving from the tail would reverse it).
        for (let i = 0; i < count; i++) {
          Transforms.moveNodes(editor, {
            at: [...listPath, 0],
            to: [...prevPath, (prevNode as any).children.length],
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
  const histEditor = editor as unknown as HistoryEditor;
  if (typeof HistoryEditor.withNewBatch === "function") {
    HistoryEditor.withNewBatch(histEditor, () => {
      Editor.withoutNormalizing(editor, fn);
    });
  } else {
    Editor.withoutNormalizing(editor, fn);
  }
}

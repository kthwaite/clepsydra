import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Editor, Element, Path, Text, Transforms } from "slate";
import { HistoryEditor } from "slate-history";
import { ReactEditor } from "slate-react";

export type WikilinkExit = "before" | "after" | "preserve";
export type WikilinkCaretEdge = "start" | "end";

export interface ParsedWikilinkDraft {
  target: string;
  alias?: string;
}

export interface WikilinkEditingController {
  active: {
    path: Path;
    initialCaret: WikilinkCaretEdge;
    returnSide: "before" | "after";
  } | null;
  begin(
    path: Path,
    initialCaret: WikilinkCaretEdge,
    returnSide: "before" | "after",
  ): void;
  commit(parsed: ParsedWikilinkDraft, exit: WikilinkExit): void;
  cancel(exit: WikilinkExit): void;
}

export function parseWikilinkDraft(draft: string): ParsedWikilinkDraft | null {
  const divider = draft.indexOf("|");
  const target = divider === -1 ? draft : draft.slice(0, divider);
  const alias = divider === -1 ? undefined : draft.slice(divider + 1);
  if (target.trim().length === 0) return null;
  return alias === undefined || alias.length === 0
    ? { target }
    : { target, alias };
}

export function findAdjacentWikilink(
  editor: Editor,
  key: "ArrowLeft" | "ArrowRight",
): {
  path: Path;
  caret: WikilinkCaretEdge;
  returnSide: "before" | "after";
} | null {
  const { selection } = editor;
  if (
    !selection ||
    !Path.equals(selection.anchor.path, selection.focus.path) ||
    selection.anchor.offset !== selection.focus.offset
  ) {
    return null;
  }

  const [current, currentPath] = Editor.node(editor, selection.anchor.path);
  if (!Text.isText(current)) return null;

  const currentIndex = currentPath[currentPath.length - 1];
  let siblingIndex: number;
  if (key === "ArrowLeft") {
    if (selection.anchor.offset !== 0) return null;
    siblingIndex = currentIndex - 1;
  } else {
    if (selection.anchor.offset !== current.text.length) return null;
    siblingIndex = currentIndex + 1;
  }

  if (siblingIndex < 0) return null;
  const siblingPath = [...Path.parent(currentPath), siblingIndex];
  if (!Editor.hasPath(editor, siblingPath)) return null;

  const [sibling] = Editor.node(editor, siblingPath);
  if (!Element.isElement(sibling) || sibling.type !== "wikilink") return null;

  return key === "ArrowLeft"
    ? { path: siblingPath, caret: "end", returnSide: "after" }
    : { path: siblingPath, caret: "start", returnSide: "before" };
}

function selectExit(editor: Editor, path: Path, exit: WikilinkExit): void {
  if (exit === "preserve") return;
  const point =
    exit === "before"
      ? Editor.before(editor, path)
      : Editor.after(editor, path);
  if (ReactEditor.isFocused(editor)) ReactEditor.blur(editor);
  if (point) Transforms.select(editor, point);
  // Slate clears selection operations in a microtask. Focus after that flush
  // so a stale DOM selectionchange cannot overwrite the requested exit point.
  queueMicrotask(() => ReactEditor.focus(editor));
}

export function useWikilinkEditingController(
  editor: Editor,
): WikilinkEditingController {
  const [active, setActive] =
    useState<WikilinkEditingController["active"]>(null);

  const begin = useCallback<WikilinkEditingController["begin"]>(
    (path, initialCaret, returnSide) => {
      setActive({ path, initialCaret, returnSide });
    },
    [],
  );

  const commit = useCallback<WikilinkEditingController["commit"]>(
    (parsed, exit) => {
      if (!active) return;

      HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
        Editor.withoutNormalizing(editor, () => {
          Transforms.setNodes(
            editor,
            { target: parsed.target },
            { at: active.path },
          );
          if (parsed.alias === undefined) {
            Transforms.unsetNodes(editor, "alias", { at: active.path });
          } else {
            Transforms.setNodes(
              editor,
              { alias: parsed.alias },
              { at: active.path },
            );
          }
        });
      });

      setActive(null);
      selectExit(editor, active.path, exit);
    },
    [active, editor],
  );

  const cancel = useCallback<WikilinkEditingController["cancel"]>(
    (exit) => {
      if (!active) return;
      setActive(null);
      selectExit(editor, active.path, exit);
    },
    [active, editor],
  );

  return useMemo(
    () => ({ active, begin, commit, cancel }),
    [active, begin, commit, cancel],
  );
}

const WikilinkEditingContext = createContext<WikilinkEditingController | null>(
  null,
);

export function WikilinkEditingProvider({
  value,
  children,
}: PropsWithChildren<{ value: WikilinkEditingController }>) {
  return (
    <WikilinkEditingContext.Provider value={value}>
      {children}
    </WikilinkEditingContext.Provider>
  );
}

export function useWikilinkEditing(): WikilinkEditingController {
  const controller = useContext(WikilinkEditingContext);
  if (!controller) {
    throw new Error(
      "useWikilinkEditing must be used within a WikilinkEditingProvider",
    );
  }
  return controller;
}

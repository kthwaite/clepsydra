import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Editor,
  Element,
  Node,
  Path,
  type PathRef,
  type Point,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";
import { ReactEditor } from "slate-react";

export type SourceExit = "before" | "after" | "preserve";
export type SourceCaretEdge = "start" | "end";
export type SourceReturnSide = "before" | "after";

/**
 * The outcome of parsing a source draft.
 *
 * - `commit` applies the draft to the element at `path`. It may set
 *   properties or replace the element.
 * - `cancel` closes the session and leaves the element unchanged.
 * - `invalid` keeps the session open; the input marks itself invalid.
 */
export type SourceParseResult =
  | { kind: "commit"; apply(editor: Editor, path: Path): void }
  | { kind: "cancel" }
  | { kind: "invalid" };

/** Per-element-type rules for inline source editing. */
export interface InlineSourceAdapter<E extends Element = Element> {
  type: E["type"];
  /** Accessible name of the source input. */
  label: string;
  /** Literal Markdown shown around the input, such as `[[` and `]]`. */
  chrome?: { open: string; close: string };
  toDraft(element: E): string;
  parse(draft: string): SourceParseResult;
}

export interface InlineSourceSession {
  type: string;
  ref: PathRef;
  initialCaret: SourceCaretEdge;
  returnSide: SourceReturnSide;
}

export interface InlineSourceEditingController {
  active: InlineSourceSession | null;
  begin(
    path: Path,
    initialCaret: SourceCaretEdge,
    returnSide: SourceReturnSide,
  ): void;
  /** Parses `draft` with the session's adapter and acts on the result. */
  commit(draft: string, exit: SourceExit): SourceParseResult["kind"] | null;
  cancel(exit: SourceExit): void;
}

export function isSessionAt(
  session: Pick<InlineSourceSession, "ref"> | null,
  path: Path,
): boolean {
  const current = session?.ref.current;
  return current != null && Path.equals(current, path);
}

export function findAdjacentSourceInline(
  editor: Editor,
  key: "ArrowLeft" | "ArrowRight",
  types: readonly string[],
): {
  path: Path;
  caret: SourceCaretEdge;
  returnSide: SourceReturnSide;
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
  if (!Element.isElement(sibling) || !types.includes(sibling.type)) {
    return null;
  }

  return key === "ArrowLeft"
    ? { path: siblingPath, caret: "end", returnSide: "after" }
    : { path: siblingPath, caret: "start", returnSide: "before" };
}

function focusAt(editor: Editor, point: Point | undefined) {
  if (ReactEditor.isFocused(editor)) ReactEditor.blur(editor);
  if (point) Transforms.select(editor, point);
  // Slate clears selection operations in a microtask. Focus after that flush
  // so a stale DOM selectionchange cannot overwrite the requested exit point.
  queueMicrotask(() => ReactEditor.focus(editor));
}

function exitPoint(editor: Editor, path: Path, exit: "before" | "after") {
  return exit === "before"
    ? Editor.before(editor, path)
    : Editor.after(editor, path);
}

export function useInlineSourceEditingController(
  editor: Editor,
  adapters: readonly InlineSourceAdapter[],
): InlineSourceEditingController {
  const [active, setActive] = useState<InlineSourceSession | null>(null);
  const activeRef = useRef<InlineSourceSession | null>(null);

  const replaceSession = useCallback((next: InlineSourceSession | null) => {
    activeRef.current?.ref.unref();
    activeRef.current = next;
    setActive(next);
  }, []);

  useEffect(
    () => () => {
      activeRef.current?.ref.unref();
    },
    [],
  );

  const begin = useCallback<InlineSourceEditingController["begin"]>(
    (path, initialCaret, returnSide) => {
      if (!Editor.hasPath(editor, path)) return;
      const node = Node.get(editor, path);
      if (!Element.isElement(node)) return;
      if (!adapters.some((adapter) => adapter.type === node.type)) return;
      replaceSession({
        type: node.type,
        ref: Editor.pathRef(editor, path),
        initialCaret,
        returnSide,
      });
    },
    [adapters, editor, replaceSession],
  );

  const cancel = useCallback<InlineSourceEditingController["cancel"]>(
    (exit) => {
      const session = activeRef.current;
      if (!session) return;
      const path = session.ref.current;
      replaceSession(null);
      if (exit === "preserve" || !path) return;
      focusAt(editor, exitPoint(editor, path, exit));
    },
    [editor, replaceSession],
  );

  const commit = useCallback<InlineSourceEditingController["commit"]>(
    (draft, exit) => {
      const session = activeRef.current;
      if (!session) return null;
      const adapter = adapters.find((a) => a.type === session.type);
      const path = session.ref.current;
      if (!adapter || !path) {
        replaceSession(null);
        return "cancel";
      }

      const result = adapter.parse(draft);
      if (result.kind === "invalid") return "invalid";
      if (result.kind === "cancel") {
        cancel(exit);
        return "cancel";
      }

      // Exit points are tracked through the edit, so an adapter may replace
      // the element and the caret still lands beside what replaced it.
      const before = Editor.before(editor, path);
      const after = Editor.after(editor, path);
      const beforeRef = before
        ? Editor.pointRef(editor, before, { affinity: "backward" })
        : null;
      const afterRef = after
        ? Editor.pointRef(editor, after, { affinity: "forward" })
        : null;

      HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
        Editor.withoutNormalizing(editor, () => result.apply(editor, path));
      });

      replaceSession(null);
      const beforePoint = beforeRef?.unref() ?? undefined;
      const afterPoint = afterRef?.unref() ?? undefined;
      if (exit !== "preserve") {
        focusAt(editor, exit === "before" ? beforePoint : afterPoint);
      }
      return "commit";
    },
    [adapters, cancel, editor, replaceSession],
  );

  return useMemo(
    () => ({ active, begin, commit, cancel }),
    [active, begin, commit, cancel],
  );
}

const InlineSourceEditingContext =
  createContext<InlineSourceEditingController | null>(null);

export function InlineSourceEditingProvider({
  value,
  children,
}: PropsWithChildren<{ value: InlineSourceEditingController }>) {
  return (
    <InlineSourceEditingContext.Provider value={value}>
      {children}
    </InlineSourceEditingContext.Provider>
  );
}

export function useInlineSourceEditing(): InlineSourceEditingController {
  const controller = useContext(InlineSourceEditingContext);
  if (!controller) {
    throw new Error(
      "useInlineSourceEditing must be used within an InlineSourceEditingProvider",
    );
  }
  return controller;
}

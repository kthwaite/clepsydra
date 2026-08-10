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
  type Location,
  type Node,
  Path,
  type PathRef,
  type RangeRef,
  Element as SlateElement,
  Transforms,
} from "slate";
import { ReactEditor } from "slate-react";
import type { BaseEmbedElement } from "#/editor/types";

export interface BaseEmbedEntryFocusHandle {
  focusEntry(): boolean;
  focusEdit(): boolean;
}

interface BeginOptions {
  insertionBookmark?: RangeRef;
}

export interface BaseEmbedEditingController {
  begin(path: Path, options?: BeginOptions): void;
  commit(replacement: BaseEmbedElement): void;
  cancel(): void;
  isActive(path: Path): boolean;
  registerEntryFocus(
    node: BaseEmbedElement,
    handle: BaseEmbedEntryFocusHandle,
  ): () => void;
  focusEntry(path: Path): boolean;
  restoreFocus(path: Path): void;
  exit(path: Path, side: "before" | "after"): void;
  remove(path: Path, node: Node): void;
  disposeNode(node: BaseEmbedElement): void;
}

interface EditingSession {
  pathRef: PathRef;
  original: Node;
  insertionBookmark?: RangeRef;
}

function pointOutside(editor: Editor, path: Path, side: "before" | "after") {
  return side === "before"
    ? (Editor.before(editor, path, { voids: true }) ??
        Editor.after(editor, path, { voids: true }))
    : (Editor.after(editor, path, { voids: true }) ??
        Editor.before(editor, path, { voids: true }));
}

function focusEditorAt(editor: Editor, target: Location | null | undefined) {
  if (!target) return;
  Transforms.select(editor, target);
  queueMicrotask(() => ReactEditor.focus(editor));
}

export function useBaseEmbedEditingController(
  editor: Editor,
): BaseEmbedEditingController {
  const sessionRef = useRef<EditingSession | null>(null);
  const entryFocusHandles = useRef(
    new WeakMap<BaseEmbedElement, BaseEmbedEntryFocusHandle>(),
  );
  const suppressNextRestore = useRef(false);
  const [sessionVersion, setSessionVersion] = useState(0);

  const releaseSession = useCallback((releaseBookmark = true) => {
    const session = sessionRef.current;
    if (!session) return;
    session.pathRef.unref();
    if (releaseBookmark) session.insertionBookmark?.unref();
    sessionRef.current = null;
    setSessionVersion((version) => version + 1);
  }, []);

  const begin = useCallback(
    (path: Path, options: BeginOptions = {}) => {
      releaseSession();
      const [original] = Editor.node(editor, path);
      sessionRef.current = {
        pathRef: Editor.pathRef(editor, path),
        original,
        ...(options.insertionBookmark
          ? { insertionBookmark: options.insertionBookmark }
          : {}),
      };
      suppressNextRestore.current = false;
      setSessionVersion((version) => version + 1);
    },
    [editor, releaseSession],
  );

  const commit = useCallback(
    (replacement: BaseEmbedElement) => {
      const session = sessionRef.current;
      const path = session?.pathRef.current;
      if (!session || !path) {
        releaseSession();
        return;
      }
      const [current] = Editor.node(editor, path);
      if (current !== session.original) {
        releaseSession();
        return;
      }

      Editor.withoutNormalizing(editor, () => {
        Transforms.removeNodes(editor, {
          at: path,
          match: (node) => node === session.original,
          voids: true,
        });
        Transforms.insertNodes(editor, replacement, { at: path, voids: true });
      });
      releaseSession();
    },
    [editor, releaseSession],
  );

  const cancel = useCallback(() => {
    const session = sessionRef.current;
    const path = session?.pathRef.current;
    if (!session || !path) {
      releaseSession();
      return;
    }
    const [current] = Editor.node(editor, path);
    if (current !== session.original || !session.insertionBookmark) {
      releaseSession();
      return;
    }

    const following = Editor.after(editor, path, { voids: true });
    const preceding = Editor.before(editor, path, { voids: true });
    const followingRef = following
      ? Editor.pointRef(editor, following, { affinity: "forward" })
      : null;
    const precedingRef = preceding
      ? Editor.pointRef(editor, preceding, { affinity: "backward" })
      : null;
    Transforms.removeNodes(editor, {
      at: path,
      match: (node) => node === session.original,
      voids: true,
    });
    const bookmark = session.insertionBookmark.unref();
    const fallback = followingRef?.unref() ?? precedingRef?.unref();
    session.pathRef.unref();
    sessionRef.current = null;
    suppressNextRestore.current = true;
    setSessionVersion((version) => version + 1);
    focusEditorAt(editor, bookmark ?? fallback);
  }, [editor, releaseSession]);

  const isActive = useCallback(
    (path: Path) => {
      const session = sessionRef.current;
      if (
        !session?.pathRef.current ||
        !Path.equals(session.pathRef.current, path)
      ) {
        return false;
      }
      const [current] = Editor.node(editor, path);
      return current === session.original;
    },
    [editor],
  );

  const registerEntryFocus = useCallback(
    (node: BaseEmbedElement, handle: BaseEmbedEntryFocusHandle) => {
      entryFocusHandles.current.set(node, handle);
      return () => {
        if (entryFocusHandles.current.get(node) === handle) {
          entryFocusHandles.current.delete(node);
        }
      };
    },
    [],
  );

  const focusEntry = useCallback(
    (path: Path) => {
      const [node] = Editor.node(editor, path);
      if (!SlateElement.isElement(node) || node.type !== "base-embed") {
        return false;
      }
      return entryFocusHandles.current.get(node)?.focusEntry() ?? false;
    },
    [editor],
  );

  const restoreFocus = useCallback(
    (path: Path) => {
      if (suppressNextRestore.current) {
        suppressNextRestore.current = false;
        return;
      }
      queueMicrotask(() => {
        if (!Editor.hasPath(editor, path)) return;
        const [node] = Editor.node(editor, path);
        if (!SlateElement.isElement(node) || node.type !== "base-embed") return;
        entryFocusHandles.current.get(node)?.focusEdit();
      });
    },
    [editor],
  );

  const exit = useCallback(
    (path: Path, side: "before" | "after") => {
      focusEditorAt(editor, pointOutside(editor, path, side));
    },
    [editor],
  );

  const remove = useCallback(
    (path: Path, node: Node) => {
      if (!Editor.hasPath(editor, path)) return;
      const [current] = Editor.node(editor, path);
      if (current !== node) return;
      const following = Editor.after(editor, path, { voids: true });
      const preceding = Editor.before(editor, path, { voids: true });
      const followingRef = following
        ? Editor.pointRef(editor, following, { affinity: "forward" })
        : null;
      const precedingRef = preceding
        ? Editor.pointRef(editor, preceding, { affinity: "backward" })
        : null;
      Transforms.removeNodes(editor, {
        at: path,
        match: (candidate) => candidate === node,
        voids: true,
      });
      const target = followingRef?.unref() ?? precedingRef?.unref();
      if (sessionRef.current?.original === node) releaseSession();
      focusEditorAt(editor, target);
    },
    [editor, releaseSession],
  );

  const disposeNode = useCallback(
    (node: BaseEmbedElement) => {
      if (sessionRef.current?.original === node) releaseSession();
    },
    [releaseSession],
  );

  useEffect(
    () => () => {
      sessionRef.current?.pathRef.unref();
      sessionRef.current?.insertionBookmark?.unref();
      sessionRef.current = null;
    },
    [],
  );

  return useMemo(
    () => ({
      begin,
      commit,
      cancel,
      isActive,
      registerEntryFocus,
      focusEntry,
      restoreFocus,
      exit,
      remove,
      disposeNode,
    }),
    [
      begin,
      cancel,
      commit,
      disposeNode,
      exit,
      focusEntry,
      isActive,
      registerEntryFocus,
      remove,
      restoreFocus,
      sessionVersion,
    ],
  );
}

const BaseEmbedEditingContext =
  createContext<BaseEmbedEditingController | null>(null);

export function BaseEmbedEditingProvider({
  value,
  children,
}: PropsWithChildren<{ value: BaseEmbedEditingController }>) {
  return (
    <BaseEmbedEditingContext.Provider value={value}>
      {children}
    </BaseEmbedEditingContext.Provider>
  );
}

export function useBaseEmbedEditing(): BaseEmbedEditingController {
  const controller = useContext(BaseEmbedEditingContext);
  if (!controller) {
    throw new Error(
      "useBaseEmbedEditing must be used inside BaseEmbedEditingProvider",
    );
  }
  return controller;
}

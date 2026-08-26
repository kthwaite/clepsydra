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
  Path,
  type PathRef,
  Element as SlateElement,
  Transforms,
} from "slate";
import { HistoryEditor } from "slate-history";

export interface MathEditingController {
  begin(path: Path): void;
  commit(tex: string): void;
  close(): void;
  isActive(path: Path): boolean;
}

export function useMathEditingController(
  editor: Editor,
): MathEditingController {
  const activePathRef = useRef<PathRef | null>(null);
  const [sessionVersion, setSessionVersion] = useState(0);

  const begin = useCallback(
    (path: Path) => {
      activePathRef.current?.unref();
      activePathRef.current = Editor.pathRef(editor, path);
      setSessionVersion((version) => version + 1);
    },
    [editor],
  );

  const commit = useCallback(
    (tex: string) => {
      const activePath = activePathRef.current?.current;
      if (!activePath || !Editor.hasPath(editor, activePath)) return;
      const [node] = Editor.node(editor, activePath);
      if (
        !SlateElement.isElement(node) ||
        (node.type !== "inline-math" && node.type !== "math-block")
      ) {
        return;
      }
      HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
        Transforms.setNodes(editor, { tex } as never, { at: activePath });
      });
    },
    [editor],
  );

  const close = useCallback(() => {
    activePathRef.current?.unref();
    activePathRef.current = null;
    setSessionVersion((version) => version + 1);
  }, []);

  const isActive = useCallback((path: Path) => {
    const activePath = activePathRef.current?.current;
    return (
      activePath !== null &&
      activePath !== undefined &&
      Path.equals(activePath, path)
    );
  }, []);

  useEffect(
    () => () => {
      activePathRef.current?.unref();
      activePathRef.current = null;
    },
    [],
  );

  return useMemo(
    () => {
      // The revision makes the controller identity reflect session changes,
      // while the callbacks themselves continue to read the live ref.
      void sessionVersion;
      return { begin, commit, close, isActive };
    },
    [begin, close, commit, isActive, sessionVersion],
  );
}

const MathEditingContext = createContext<MathEditingController | null>(null);

export function MathEditingProvider({
  value,
  children,
}: PropsWithChildren<{ value: MathEditingController }>) {
  return (
    <MathEditingContext.Provider value={value}>
      {children}
    </MathEditingContext.Provider>
  );
}

export function useMathEditing(): MathEditingController {
  const controller = useContext(MathEditingContext);
  if (!controller) {
    throw new Error("useMathEditing must be used within a MathEditingProvider");
  }
  return controller;
}

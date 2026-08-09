import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Editor, Path, Transforms } from "slate";
import { HistoryEditor } from "slate-history";

export interface MathEditingController {
  activePath: Path | null;
  begin(path: Path): void;
  commit(tex: string): void;
  close(): void;
  isActive(path: Path): boolean;
}

export function useMathEditingController(
  editor: Editor,
): MathEditingController {
  const [activePath, setActivePath] = useState<Path | null>(null);

  const begin = useCallback((path: Path) => {
    setActivePath(path);
  }, []);

  const commit = useCallback(
    (tex: string) => {
      if (!activePath || !Editor.hasPath(editor, activePath)) return;
      HistoryEditor.withNewBatch(editor as HistoryEditor, () => {
        Transforms.setNodes(editor, { tex } as never, { at: activePath });
      });
    },
    [activePath, editor],
  );

  const close = useCallback(() => {
    setActivePath(null);
  }, []);

  const isActive = useCallback(
    (path: Path) => activePath !== null && Path.equals(activePath, path),
    [activePath],
  );

  return useMemo(
    () => ({ activePath, begin, commit, close, isActive }),
    [activePath, begin, close, commit, isActive],
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

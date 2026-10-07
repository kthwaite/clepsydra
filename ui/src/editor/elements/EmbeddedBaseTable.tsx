import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
} from "react";
import type { Path } from "slate";
import { Transforms } from "slate";
import { useSlateStatic } from "slate-react";
import {
  BaseTableView,
  type BaseTableViewHandle,
} from "#/components/bases/BaseTableView";
import { useBaseTableController } from "#/components/bases/useBaseTableController";
import type { ConfiguredBaseEmbedElement } from "#/editor/types";

interface EmbeddedBaseTableProps {
  element: ConfiguredBaseEmbedElement;
  view: string;
  path: Path;
  chrome: "full" | "compact";
  /** Rendered in the table's toolbar, or beside the message that replaces it. */
  actions?: ReactNode;
}

export const EmbeddedBaseTable = forwardRef<
  BaseTableViewHandle,
  EmbeddedBaseTableProps
>(function EmbeddedBaseTable({ element, view, path, chrome, actions }, ref) {
  const editor = useSlateStatic();
  const mounted = useRef(true);
  const pendingSortReset = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      pendingSortReset.current += 1;
      mounted.current = false;
    };
  }, []);

  const setView = useCallback(
    (view: string) => {
      pendingSortReset.current += 1;
      if (!mounted.current) return;
      Transforms.setNodes(
        editor,
        { view, sort: undefined },
        {
          at: path,
          match: (node) => node === element,
          voids: true,
        },
      );
    },
    [editor, element, path],
  );

  const setSort = useCallback(
    (sort: ConfiguredBaseEmbedElement["sort"]) => {
      const applySort = () => {
        if (!mounted.current) return;
        Transforms.setNodes(
          editor,
          { sort },
          {
            at: path,
            match: (node) => node === element,
            voids: true,
          },
        );
      };
      if (sort !== undefined) {
        pendingSortReset.current += 1;
        applySort();
        return;
      }
      const token = ++pendingSortReset.current;
      queueMicrotask(() => {
        if (pendingSortReset.current === token) applySort();
      });
    },
    [editor, element, path],
  );

  const model = useBaseTableController({
    mode: "embedded",
    slug: element.base,
    activeView: view,
    sort: element.sort,
    ...(element.filter === undefined ? {} : { filter: element.filter }),
    ...(element.limit === undefined ? {} : { limit: element.limit }),
    onViewChange: setView,
    onSortChange: setSort,
  });

  return (
    <BaseTableView
      ref={ref}
      model={model}
      chrome={chrome}
      {...(actions === undefined ? {} : { toolbarActions: actions })}
    />
  );
});

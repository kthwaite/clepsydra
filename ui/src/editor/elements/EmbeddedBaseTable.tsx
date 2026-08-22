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
  path: Path;
  chrome: "full" | "compact";
  /** Rendered in the table's toolbar, or beside the message that replaces it. */
  actions?: ReactNode;
}

export const EmbeddedBaseTable = forwardRef<
  BaseTableViewHandle,
  EmbeddedBaseTableProps
>(function EmbeddedBaseTable({ element, path, chrome, actions }, ref) {
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

  const controller = useBaseTableController({
    mode: "embedded",
    slug: element.base,
    activeView: element.view,
    sort: element.sort,
    ...(element.filter === undefined ? {} : { filter: element.filter }),
    ...(element.limit === undefined ? {} : { limit: element.limit }),
    onViewChange: setView,
    onSortChange: setSort,
  });
  const { detailLoading, detailMissing, definition, ...viewProps } = controller;

  // The Base cannot be rendered, but the embed still has to be editable and
  // removable — so the actions travel with the message that replaces it.
  const withActions = (message: ReactNode) =>
    actions === undefined ? (
      message
    ) : (
      <div className="flex flex-wrap items-center justify-between gap-2">
        {message}
        <span className="flex items-center gap-2">{actions}</span>
      </div>
    );

  if (detailLoading && !definition) {
    return withActions(
      <p role="status" className="cl-mono p-4 text-[12px] text-ink-mute">
        Loading Base embed…
      </p>,
    );
  }
  if (detailMissing || !definition) {
    return withActions(
      <p role="alert" className="cl-mono p-4 text-[12px] text-ink-mute">
        No Base named “{element.base}” is available. Edit the embed to choose a
        saved Base and view.
      </p>,
    );
  }

  return (
    <BaseTableView
      ref={ref}
      definition={definition}
      {...viewProps}
      chrome={chrome}
      {...(actions === undefined ? {} : { toolbarActions: actions })}
      configureSlug={element.base}
    />
  );
});

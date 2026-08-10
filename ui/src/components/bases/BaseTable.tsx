import { useState } from "react";
import type { SortKey } from "#/api/bases";
import { BaseTableView } from "./BaseTableView";
import { useBaseTableController } from "./useBaseTableController";

interface BaseTableProps {
  slug: string;
}

/** Standalone Base route wrapper with local view and sort overrides. */
export function BaseTable({ slug }: BaseTableProps) {
  const [activeView, setActiveView] = useState("");
  const [sort, setSort] = useState<SortKey[] | undefined>();
  const controller = useBaseTableController({
    mode: "standalone",
    slug,
    activeView,
    sort,
    onViewChange: setActiveView,
    onSortChange: setSort,
  });
  const { detailLoading, detailMissing, definition, ...viewProps } = controller;

  if (detailLoading) {
    return <p className="cl-mono p-4 text-[12px] text-ink-mute">Loading…</p>;
  }
  if (detailMissing || !definition) {
    return (
      <p className="cl-mono p-4 text-[12px] text-ink-mute">
        No base named “{slug}” (or it declares no views).
      </p>
    );
  }

  return <BaseTableView definition={definition} {...viewProps} />;
}

import { useState } from "react";
import {
  useBase,
  useBaseView,
  usePropertyCommit,
  type ViewOverrides,
} from "#/api/bases";
import { useOpenTab } from "#/hooks/useOpenTab";
import { BaseTableView } from "./BaseTableView";

export interface BaseTableProps {
  slug: string;
}

/** Data wiring for {@link BaseTableView}: queries, cell commits, navigation. */
export function BaseTable({ slug }: BaseTableProps) {
  const openTab = useOpenTab();
  const detail = useBase(slug);
  const [viewName, setViewName] = useState<string | undefined>(undefined);
  const [sortOverride, setSortOverride] = useState<ViewOverrides>({});

  const activeView = viewName ?? detail.data?.views?.[0]?.name;
  const viewQuery = useBaseView(slug, activeView, sortOverride);
  const commit = usePropertyCommit();

  if (detail.isLoading) {
    return <p className="cl-mono p-4 text-[12px] text-ink-mute">Loading…</p>;
  }
  if (detail.error || !detail.data || !activeView) {
    return (
      <p className="cl-mono p-4 text-[12px] text-ink-mute">
        No base named “{slug}” (or it declares no views).
      </p>
    );
  }

  return (
    <BaseTableView
      definition={detail.data}
      activeView={activeView}
      onViewChange={(name) => {
        setViewName(name);
        setSortOverride({});
      }}
      output={viewQuery.data}
      sortOverride={sortOverride}
      onSortChange={setSortOverride}
      onOpenPage={(path) => openTab("page", path)}
      onCommitCell={(row, key, value, hint) => {
        void commit(row, key, value, hint);
      }}
    />
  );
}

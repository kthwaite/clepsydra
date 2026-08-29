import { useCallback, useEffect, useMemo, useState } from "react";
import { type SortKey, useBase } from "#/api/bases";
import { BaseTableView } from "./BaseTableView";
import { useBaseTableController } from "./useBaseTableController";
import {
  getViewStateStorage,
  readLastView,
  resolveActiveView,
  writeLastView,
} from "./view-state";

interface BaseTableProps {
  slug: string;
  /** The view named in the URL, when there is one. */
  requestedView?: string;
  /** Reports an explicit view switch, for the URL to follow. */
  onViewChange?(name: string): void;
  /** Asks the URL to drop a `view` that names no saved view. */
  onScrubView?(): void;
}

/** A view chosen in this session, valid while the URL still says what it did then. */
interface ChosenView {
  under: string | undefined;
  name: string;
}

/** Standalone Base route wrapper with local view and sort overrides. */
export function BaseTable({
  slug,
  requestedView,
  onViewChange,
  onScrubView,
}: BaseTableProps) {
  // Deduplicated with the controller's query; needed here to resolve the
  // view before the controller asks for its rows.
  const detail = useBase(slug);
  const views = detail.data?.views;
  const remembered = useMemo(
    () => readLastView(getViewStateStorage(), slug),
    [slug],
  );
  const [chosen, setChosen] = useState<ChosenView | undefined>();
  const chosenName =
    chosen !== undefined && chosen.under === requestedView
      ? chosen.name
      : undefined;
  const { view: activeView, scrub } = useMemo(
    () =>
      resolveActiveView(views ?? [], chosenName ?? requestedView, remembered),
    [chosenName, remembered, requestedView, views],
  );
  useEffect(() => {
    if (scrub) onScrubView?.();
  }, [onScrubView, scrub]);
  const [sort, setSort] = useState<SortKey[] | undefined>();
  const handleViewChange = useCallback(
    (name: string) => {
      setChosen({ under: requestedView, name });
      writeLastView(getViewStateStorage(), slug, name);
      onViewChange?.(name);
    },
    [onViewChange, requestedView, slug],
  );
  const controller = useBaseTableController({
    mode: "standalone",
    slug,
    activeView,
    sort,
    onViewChange: handleViewChange,
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

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import {
  type PropertyType,
  type QueryRow,
  useBase,
  useBaseView,
  usePatchProperties,
  type ViewOverrides,
} from "#/api/bases";
import { invalidateByPath, queryKeys } from "#/api/keys";
import { useOpenTab } from "#/hooks/useOpenTab";
import { BaseTableView } from "./BaseTableView";
import type { CellValue } from "./cells/types";

export interface BaseTableProps {
  slug: string;
}

/** Data wiring for {@link BaseTableView}: queries, cell commits, navigation. */
export function BaseTable({ slug }: BaseTableProps) {
  const qc = useQueryClient();
  const openTab = useOpenTab();
  const detail = useBase(slug);
  const [viewName, setViewName] = useState<string | undefined>(undefined);
  const [sortOverride, setSortOverride] = useState<ViewOverrides>({});

  const activeView = viewName ?? detail.data?.views?.[0]?.name;
  const viewQuery = useBaseView(slug, activeView, sortOverride);
  const patch = usePatchProperties();

  const commitCell = useCallback(
    async (
      row: QueryRow,
      key: string,
      value: CellValue,
      hint?: PropertyType,
    ) => {
      try {
        // The patch is revision-guarded; fetch the page's current revision
        // first. A lost race surfaces as a 409 below.
        const pageRes = await fetch(
          `/api/vault/pages/${encodeURIComponent(row.path).replaceAll("%2F", "/")}`,
        );
        if (!pageRes.ok)
          throw new Error(`page fetch failed: ${pageRes.status}`);
        const { revision } = (await pageRes.json()) as { revision: string };

        await patch.mutateAsync({
          params: { path: { uuid: row.id } },
          body: {
            set: value === null ? {} : { [key]: value },
            clear: value === null ? [key] : [],
            types: hint ? { [key]: hint } : {},
            expected_revision: revision,
          },
        });
      } catch {
        // Conflict or transport failure: surface it and refetch so the table
        // shows the winning state. The cell's draft lives in its editor, so
        // the user can reopen and retry.
        toast.error(`Could not update ${key} — refreshed to current state`);
        invalidateByPath(qc, queryKeys.bases.pathPrefix);
        invalidateByPath(qc, queryKeys.query.pathPrefix);
      }
    },
    [patch, qc],
  );

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
        void commitCell(row, key, value, hint);
      }}
    />
  );
}

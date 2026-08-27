import {
  createFileRoute,
  type SearchSchemaInput,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { DesktopOnlyRoute } from "#/components/codex/DesktopOnlyRoute";
import { TaskingScreen } from "#/components/tasking/TaskingScreen";
import { useOpenTab } from "#/hooks/useOpenTab";
import type { FilterState } from "#/lib/filters/model";
import {
  canonicalizeFilterSearch,
  type FilterUrlOptions,
  mergeFilterSearch,
  parseFilterSearch,
  shouldReplaceFilterHistory,
} from "#/lib/filters/url";

const TASKING_ROUTE_PATH = "/tasking" as const;

/** Route-level filter field specs for the Tasking board's URL-backed filter. */
export const TASKING_FILTER_URL: FilterUrlOptions = {
  fields: [
    { id: "project", kind: "multi" },
    { id: "tags", kind: "multi" },
    { id: "pri", kind: "multi", normalize: (v) => v.toUpperCase() },
    { id: "status", kind: "multi", normalize: (v) => v.toUpperCase() },
    { id: "hold", kind: "flag" },
  ],
};

export function taskingFilterNavigation(
  next: FilterState,
  previous: FilterState,
) {
  return {
    to: TASKING_ROUTE_PATH,
    search: <TSearch extends Record<string, unknown>>(current: TSearch) =>
      mergeFilterSearch(current, next, TASKING_FILTER_URL),
    replace: shouldReplaceFilterHistory(next, previous),
  };
}

/**
 * Resolve a dossier canonical name to a vault path via the search index, then
 * open the first matching page. Fires a one-off fetch rather than a hook
 * because this is an imperative click handler, not a render-time query.
 */
async function resolveDossierPath(name: string): Promise<string | null> {
  try {
    const res = await fetch(
      `/api/vault/index/search?q=${encodeURIComponent(name)}&limit=1`,
    );
    if (!res.ok) return null;
    const results = (await res.json()) as Array<{ path: string }>;
    return results[0]?.path ?? null;
  } catch {
    return null;
  }
}

function TaskingRoute() {
  const openTab = useOpenTab();
  const search = Route.useSearch();
  const navigate = useNavigate();

  const filterState = useMemo(
    () => parseFilterSearch(search, TASKING_FILTER_URL),
    [search],
  );

  const onFilterChange = useCallback(
    (next: FilterState) => {
      navigate(taskingFilterNavigation(next, filterState));
    },
    [navigate, filterState],
  );

  const onOpenPage = useCallback(
    (path: string) => {
      openTab("page", path);
    },
    [openTab],
  );

  const onOpenDossier = useCallback(
    (link: string) => {
      void resolveDossierPath(link).then((path) => {
        if (path) openTab("page", path, link);
      });
    },
    [openTab],
  );

  return (
    <DesktopOnlyRoute name="Tasking">
      <TaskingScreen
        onOpenPage={onOpenPage}
        onOpenDossier={onOpenDossier}
        filterState={filterState}
        onFilterChange={onFilterChange}
      />
    </DesktopOnlyRoute>
  );
}

export const Route = createFileRoute("/tasking")({
  staticData: { codexView: "tasking" },
  validateSearch: (search: Record<string, unknown> & SearchSchemaInput) =>
    canonicalizeFilterSearch(search, TASKING_FILTER_URL),
  component: TaskingRoute,
});

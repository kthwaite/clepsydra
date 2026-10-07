import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { MobileTasking } from "#/components/mobile/MobileTasking";
import { TaskingScreen } from "#/components/tasking/TaskingScreen";
import { TASKING_FACETS } from "#/components/tasking/taskingFacets";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenTab } from "#/hooks/useOpenTab";
import { defineFilterRoute, useFilterRoute } from "#/lib/filters/route";

/** The Tasking board's URL-backed filter. */
export const TASKING_FILTER = defineFilterRoute({
  to: "/tasking",
  facets: TASKING_FACETS,
});

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
  const mobile = useMobileLayout();
  const { filterState, onFilterChange } = useFilterRoute(
    TASKING_FILTER,
    Route.useSearch(),
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

  if (mobile) return <MobileTasking />;

  return (
    <TaskingScreen
      onOpenPage={onOpenPage}
      onOpenDossier={onOpenDossier}
      filterState={filterState}
      onFilterChange={onFilterChange}
    />
  );
}

export const Route = createFileRoute("/tasking")({
  staticData: { codexView: "tasking" },
  validateSearch: TASKING_FILTER.validateSearch,
  component: TaskingRoute,
});

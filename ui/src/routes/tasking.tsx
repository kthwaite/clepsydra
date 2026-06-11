import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import { useOpenTab } from "#/hooks/useOpenTab";
import { TaskingScreen } from "#/components/tasking/TaskingScreen";

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
    <TaskingScreen onOpenPage={onOpenPage} onOpenDossier={onOpenDossier} />
  );
}

export const Route = createFileRoute("/tasking")({
  component: TaskingRoute,
});

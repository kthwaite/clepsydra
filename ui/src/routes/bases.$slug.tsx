import {
  createFileRoute,
  Outlet,
  useMatchRoute,
  useNavigate,
} from "@tanstack/react-router";
import { useCallback } from "react";
import { BaseTable } from "#/components/bases/BaseTable";

export interface BasesSlugSearch {
  /** The saved view to open, by name. Absent means remembered-or-first. */
  view?: string;
}

/** A non-empty trimmed `view` survives; anything else is dropped. */
export function parseBasesSlugSearch(
  search: Record<string, unknown>,
): BasesSlugSearch {
  const view = typeof search.view === "string" ? search.view.trim() : "";
  return view ? { view } : {};
}

function BasesRoute() {
  const { slug } = Route.useParams();
  const { view } = Route.useSearch();
  const navigate = useNavigate();
  const matchRoute = useMatchRoute();
  const handleViewChange = useCallback(
    (name: string) => {
      void navigate({
        to: "/bases/$slug",
        params: { slug },
        search: { view: name },
        replace: true,
      });
    },
    [navigate, slug],
  );
  const handleScrubView = useCallback(() => {
    void navigate({
      to: "/bases/$slug",
      params: { slug },
      search: {},
      replace: true,
    });
  }, [navigate, slug]);
  if (matchRoute({ to: "/bases/$slug/edit", params: { slug } })) {
    return <Outlet />;
  }
  return (
    <div className="mx-auto max-w-5xl p-4">
      {/* Keyed by slug so view selection and sort overrides reset when
          navigating between bases (param-only navigation reuses the node). */}
      <BaseTable
        key={slug}
        slug={slug}
        requestedView={view}
        onViewChange={handleViewChange}
        onScrubView={handleScrubView}
      />
    </div>
  );
}

export const Route = createFileRoute("/bases/$slug")({
  staticData: { codexView: "bases" },
  validateSearch: parseBasesSlugSearch,
  component: BasesRoute,
});

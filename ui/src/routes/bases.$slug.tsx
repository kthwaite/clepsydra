import { createFileRoute, Outlet, useMatchRoute } from "@tanstack/react-router";
import { BaseTable } from "#/components/bases/BaseTable";

function BasesRoute() {
  const { slug } = Route.useParams();
  const matchRoute = useMatchRoute();
  if (matchRoute({ to: "/bases/$slug/edit", params: { slug } })) {
    return <Outlet />;
  }
  return (
    <div className="mx-auto max-w-5xl p-4">
      {/* Keyed by slug so view selection and sort overrides reset when
          navigating between bases (param-only navigation reuses the node). */}
      <BaseTable key={slug} slug={slug} />
    </div>
  );
}

export const Route = createFileRoute("/bases/$slug")({
  staticData: { codexView: "bases" },
  component: BasesRoute,
});

import { createFileRoute } from "@tanstack/react-router";
import { BaseTable } from "#/components/bases/BaseTable";

function BasesRoute() {
  const { slug } = Route.useParams();
  return (
    <div className="mx-auto max-w-5xl p-4">
      <BaseTable slug={slug} />
    </div>
  );
}

export const Route = createFileRoute("/bases/$slug")({
  component: BasesRoute,
});

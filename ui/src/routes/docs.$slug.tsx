import { createFileRoute } from "@tanstack/react-router";
import { DocsScreen } from "#/components/docs/DocsScreen";

function DocsRoute() {
  // Remove the temporary route boundaries after the controller regenerates
  // routeTree.gen.ts with the Task 7 file routes.
  const { slug } = Route.useParams() as { slug: string };
  return <DocsScreen slug={slug} />;
}

export const Route = createFileRoute("/docs/$slug")({
  component: DocsRoute,
});

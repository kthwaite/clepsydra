import { createFileRoute } from "@tanstack/react-router";
import { DocsScreen } from "#/components/docs/DocsScreen";

function DocsRoute() {
  const { slug } = Route.useParams();
  return <DocsScreen slug={slug} />;
}

export const Route = createFileRoute("/docs/$slug")({
  component: DocsRoute,
});

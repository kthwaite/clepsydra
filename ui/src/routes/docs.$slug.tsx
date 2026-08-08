import { createFileRoute } from "@tanstack/react-router";
import { DesktopOnlyRoute } from "#/components/codex/DesktopOnlyRoute";
import { DocsScreen } from "#/components/docs/DocsScreen";

function DocsRoute() {
  const { slug } = Route.useParams();
  return (
    <DesktopOnlyRoute name="Docs">
      <DocsScreen slug={slug} />
    </DesktopOnlyRoute>
  );
}

export const Route = createFileRoute("/docs/$slug")({
  component: DocsRoute,
});

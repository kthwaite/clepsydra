import { createFileRoute } from "@tanstack/react-router";
import { BaseDefinitionWorkspace } from "#/components/bases/BaseDefinitionWorkspace";

function BaseDefinitionEditRoute() {
  const { slug } = Route.useParams();
  return <BaseDefinitionWorkspace key={slug} slug={slug} />;
}

export const Route = createFileRoute("/bases/$slug/edit")({
  component: BaseDefinitionEditRoute,
});

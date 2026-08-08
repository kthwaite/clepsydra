import { createFileRoute } from "@tanstack/react-router";
import { BasesIndex } from "#/components/bases/BasesIndex";

function BasesIndexRoute() {
  return <BasesIndex />;
}

export const Route = createFileRoute("/bases/")({
  component: BasesIndexRoute,
});

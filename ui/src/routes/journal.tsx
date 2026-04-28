import { createFileRoute } from "@tanstack/react-router";
import { Diurnal } from "#/components/codex/Diurnal";

export const Route = createFileRoute("/journal")({
  component: Diurnal,
});

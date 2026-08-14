import { createFileRoute } from "@tanstack/react-router";
import { Stats } from "#/components/codex/Stats";

export const Route = createFileRoute("/stats")({
  staticData: { codexView: "stats" },
  component: Stats,
});

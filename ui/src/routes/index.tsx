import { createFileRoute } from "@tanstack/react-router";
import { Atrium } from "#/components/codex/Atrium";

export const Route = createFileRoute("/")({
  staticData: { codexView: "atrium" },
  component: Atrium,
});

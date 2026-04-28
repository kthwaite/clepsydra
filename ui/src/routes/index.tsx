import { createFileRoute } from "@tanstack/react-router";
import { Atrium } from "#/components/codex/Atrium";

export const Route = createFileRoute("/")({
  component: Atrium,
});

import { createFileRoute } from "@tanstack/react-router";
import { ConflictsPanel } from "#/components/conflicts/ConflictsPanel";

export const Route = createFileRoute("/conflicts")({
  staticData: { codexView: "conflicts" },
  component: ConflictsPage,
});

function ConflictsPage() {
  return <ConflictsPanel />;
}

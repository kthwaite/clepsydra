import { createFileRoute } from "@tanstack/react-router";
import { TabContent } from "#/components/TabContent";
import { useFolioHistoryController } from "#/hooks/useFolioHistoryNavigation";

export const Route = createFileRoute("/workspace")({
  staticData: { codexView: "workspace" },
  component: WorkspaceRoute,
});

function WorkspaceRoute() {
  useFolioHistoryController();
  return <TabContent />;
}

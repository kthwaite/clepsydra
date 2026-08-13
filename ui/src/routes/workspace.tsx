import { createFileRoute } from "@tanstack/react-router";
import { TabContent } from "#/components/TabContent";

export const Route = createFileRoute("/workspace")({
  staticData: { codexView: "workspace" },
  component: TabContent,
});

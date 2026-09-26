import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { runWorkspaceTransition, useWorkspaceStore } from "#/store/workspace";

export const Route = createFileRoute("/graph")({
  staticData: { codexView: "workspace" },
  component: GraphRedirect,
});

function GraphRedirect() {
  const openTab = useWorkspaceStore((s) => s.openTab);
  const navigate = useNavigate();

  useEffect(() => {
    runWorkspaceTransition(() => {
      openTab("graph");
      void navigate({ to: "/workspace", replace: true });
    });
  }, [openTab, navigate]);

  return <p className="p-8 text-[14px] text-mute">Redirecting…</p>;
}

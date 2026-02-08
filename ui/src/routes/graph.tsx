import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useWorkspaceStore } from "#/store/workspace";

export const Route = createFileRoute("/graph")({
  component: GraphRedirect,
});

function GraphRedirect() {
  const openTab = useWorkspaceStore((s) => s.openTab);
  const navigate = useNavigate();

  useEffect(() => {
    openTab("graph");
    navigate({ to: "/workspace", replace: true });
  }, [openTab, navigate]);

  return <div className="p-8 text-muted-foreground">Redirecting...</div>;
}

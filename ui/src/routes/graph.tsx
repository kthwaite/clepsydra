import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import {
  runWorkspaceTransition,
  useWorkspaceStore,
} from "#/store/workspace";

export const Route = createFileRoute("/graph")({
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

  return <div className="p-8 text-muted-foreground">Redirecting...</div>;
}

import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { runWorkspaceTransition, useWorkspaceStore } from "#/store/workspace";

export const Route = createFileRoute("/pages/$")({
  staticData: { codexView: "workspace" },
  component: PageRedirect,
});

function PageRedirect() {
  const { _splat: path } = Route.useParams();
  const openTab = useWorkspaceStore((s) => s.openTab);
  const navigate = useNavigate();

  useEffect(() => {
    if (path) {
      runWorkspaceTransition(() => {
        openTab("page", path);
        void navigate({ to: "/workspace", replace: true });
      });
    }
  }, [path, openTab, navigate]);

  return <div className="p-8 text-muted-foreground">Redirecting...</div>;
}

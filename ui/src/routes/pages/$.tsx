import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useWorkspaceStore } from "#/store/workspace";

export const Route = createFileRoute("/pages/$")({
  component: PageRedirect,
});

function PageRedirect() {
  const { _splat: path } = Route.useParams();
  const openTab = useWorkspaceStore((s) => s.openTab);
  const navigate = useNavigate();

  useEffect(() => {
    if (path) {
      openTab("page", path);
      navigate({ to: "/workspace", replace: true });
    }
  }, [path, openTab, navigate]);

  return <div className="p-8 text-muted-foreground">Redirecting...</div>;
}

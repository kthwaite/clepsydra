import {
  createFileRoute,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { pagePreviewTarget, previewOpenTarget } from "#/lib/previewTarget";
import { runWorkspaceTransition, useWorkspaceStore } from "#/store/workspace";

export const Route = createFileRoute("/pages/$")({
  staticData: { codexView: "workspace" },
  component: PageRedirect,
});

function PageRedirect() {
  const { _splat: path } = Route.useParams();
  const hash = useLocation({ select: (location) => location.hash });
  const pathname = useLocation({ select: (location) => location.pathname });
  const openTab = useWorkspaceStore((s) => s.openTab);
  const navigate = useNavigate();

  useEffect(() => {
    // The outgoing route can remount while the workspace transition finishes.
    // Its old params must not reopen the page with the destination's empty hash.
    if (path && pathname.startsWith("/pages/")) {
      runWorkspaceTransition(() => {
        const target = pagePreviewTarget(
          `/pages/${encodeURIComponent(path)}${hash ? `#${hash}` : ""}`,
        );
        openTab(
          "page",
          path,
          undefined,
          target ? previewOpenTarget(target) : undefined,
        );
        void navigate({ to: "/workspace", replace: true });
      });
    }
  }, [path, pathname, hash, openTab, navigate]);

  return <p className="px-10 py-8 text-[14px] text-mute">Redirecting…</p>;
}

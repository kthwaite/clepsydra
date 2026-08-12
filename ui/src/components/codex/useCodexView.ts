import { useRouterState } from "@tanstack/react-router";
import type { TabDescriptor } from "#/store/workspace";
import { selectWorkspaceMode, useWorkspaceStore } from "#/store/workspace";

export type CodexView =
  | "atrium"
  | "folio"
  | "launcher"
  | "constellation"
  | "gazetteer"
  | "tasking"
  | "academic"
  | "bases"
  | "feeds"
  | "docs"
  | "repairs"
  | "agenda";

/** Views resolvable from the route alone, plus the "workspace" marker that
 * defers to the workspace store (folio/constellation/launcher split). */
export type RouteView =
  | Exclude<CodexView, "folio" | "launcher" | "constellation">
  | "workspace";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    codexView?: RouteView;
  }
}

type MatchLike = { staticData?: { codexView?: RouteView } };

/** Deepest-first scan for the first route that declares its view. The root
 * route declares "atrium", so this is total over real match arrays. */
export function routeViewFromMatches(
  matches: ReadonlyArray<MatchLike>,
): RouteView {
  for (let i = matches.length - 1; i >= 0; i--) {
    const view = matches[i].staticData?.codexView;
    if (view) return view;
  }
  return "atrium";
}

/** The current CodexView. Route-declared via staticData; the workspace
 * marker defers to selectWorkspaceMode. Re-renders only when the resolved
 * view string changes. */
export function useCodexView(): CodexView {
  const routeView = useRouterState({
    select: (s) => routeViewFromMatches(s.matches),
  });
  const mode = useWorkspaceStore(selectWorkspaceMode);
  return routeView === "workspace" ? mode : routeView;
}

export function resolveCodexView(
  pathname: string,
  tabs: TabDescriptor[],
  activeTabId: string | null,
): CodexView {
  if (pathname === "/" || pathname === "") return "atrium";
  if (pathname === "/feeds" || pathname.startsWith("/feeds/")) return "feeds";
  if (pathname === "/docs" || pathname.startsWith("/docs/")) return "docs";
  if (pathname === "/bases" || pathname.startsWith("/bases/")) return "bases";
  if (pathname === "/academic" || pathname.startsWith("/academic/"))
    return "academic";
  if (pathname.startsWith("/gazetteer")) return "gazetteer";
  if (pathname.startsWith("/tasking")) return "tasking";
  if (pathname.startsWith("/workspace")) {
    const active = tabs.find((tab) => tab.id === activeTabId);
    return active?.type === "graph" ? "constellation" : "folio";
  }
  return "atrium";
}

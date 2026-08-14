import { useRouterState } from "@tanstack/react-router";
import { selectWorkspaceMode, useWorkspaceStore } from "#/store/workspace";

export type CodexView =
  | "atrium"
  | "folio"
  | "launcher"
  | "constellation"
  | "gazetteer"
  | "stats"
  | "tasking"
  | "academic"
  | "bases"
  | "feeds"
  | "docs"
  | "repairs"
  | "archive"
  | "rubbish"
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

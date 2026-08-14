import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "#/routeTree.gen";

// Mirrors the `routePaths()` accessor in docs/featureInventory.test.ts:
// a route's `fullPath`/`parentRoute` only resolve once a router has been
// built from the tree (they're populated by `route.init()`, which
// `createRouter` calls), so the raw generated tree isn't walkable directly.
type AnyRoute = {
  id: string;
  fullPath: string;
  options?: { staticData?: { codexView?: string } };
  parentRoute?: AnyRoute;
};

// Keyed by route `id` rather than `fullPath`: the root route and the index
// route ("/") share the fullPath "/", so `id` ("__root__" vs "/") is the
// only unambiguous key. Every one of the 16 `staticData` declarations added
// across these view tasks is asserted here directly — no inheritance involved.
// Routes not listed (e.g. "/docs/$slug") are expected to inherit rather than
// declare their own codexView.
const OWN_CODEX_VIEW_BY_ROUTE_ID: Record<string, string> = {
  __root__: "atrium",
  "/": "atrium",
  "/gazetteer": "gazetteer",
  "/stats": "stats",
  "/tasking": "tasking",
  "/academic": "academic",
  "/agenda": "agenda",
  "/repairs": "repairs",
  "/feeds": "feeds",
  "/docs": "docs",
  "/bases/": "bases",
  "/bases/$slug": "bases",
  "/bases/$slug/edit": "bases",
  "/workspace": "workspace",
  "/graph": "workspace",
  "/pages/$": "workspace",
};

function resolveView(route: AnyRoute): string | undefined {
  let current: AnyRoute | undefined = route;
  while (current) {
    const view = current.options?.staticData?.codexView;
    if (view) return view;
    current = current.parentRoute;
  }
  return undefined;
}

describe("route codexView coverage", () => {
  it("every route resolves a view through itself or an ancestor", () => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const routes = Object.values(router.routesById) as unknown as AnyRoute[];
    expect(routes.length).toBeGreaterThan(0);

    const missing = routes
      .filter((route) => resolveView(route) === undefined)
      .map((route) => route.fullPath);
    expect(missing).toEqual([]);
  });

  it("declares codexView directly on each route that owns it, not just via the root fallback", () => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    const routesById = router.routesById as unknown as Record<string, AnyRoute>;

    const actual = Object.fromEntries(
      Object.keys(OWN_CODEX_VIEW_BY_ROUTE_ID).map((id) => [
        id,
        routesById[id]?.options?.staticData?.codexView,
      ]),
    );
    expect(actual).toEqual(OWN_CODEX_VIEW_BY_ROUTE_ID);

    // Routes deliberately left undeclared inherit from their parent instead
    // (verified by the coverage test above); this pins that "/docs/$slug"
    // in particular stays undeclared rather than silently gaining its own.
    expect(routesById["/docs/$slug"]?.options?.staticData?.codexView).toBe(
      undefined,
    );
  });
});

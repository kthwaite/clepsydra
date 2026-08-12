import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "#/routeTree.gen";

// Mirrors the `routePaths()` accessor in docs/featureInventory.test.ts:
// a route's `fullPath`/`parentRoute` only resolve once a router has been
// built from the tree (they're populated by `route.init()`, which
// `createRouter` calls), so the raw generated tree isn't walkable directly.
type AnyRoute = {
  fullPath: string;
  options?: { staticData?: { codexView?: string } };
  parentRoute?: AnyRoute;
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
});

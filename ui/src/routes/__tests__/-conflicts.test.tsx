import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "#/routeTree.gen";

describe("conflicts route", () => {
  it("matches /conflicts and declares the conflicts codexView", async () => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/conflicts"] }),
    });
    await router.load();

    expect(router.state.location.pathname).toBe("/conflicts");
    const match = router.state.matches.at(-1);
    expect(match?.routeId).toBe("/conflicts");
    expect(
      router.routesById["/conflicts"]?.options?.staticData?.codexView,
    ).toBe("conflicts");
  });

  it("matches /conflicts/compare/<copy path> as a sibling of the list", async () => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({
        initialEntries: ["/conflicts/compare/notes/plan.conflict.abc1234.md"],
      }),
    });
    await router.load();

    const match = router.state.matches.at(-1);
    expect(match?.routeId).toBe("/conflicts_/compare/$");
    expect(match?.params).toMatchObject({
      _splat: "notes/plan.conflict.abc1234.md",
    });
    expect(router.state.matches.map((each) => each.routeId)).not.toContain(
      "/conflicts",
    );
  });
});

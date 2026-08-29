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
});

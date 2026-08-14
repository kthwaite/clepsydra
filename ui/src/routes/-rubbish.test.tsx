import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "#/routeTree.gen";

describe("rubbish route", () => {
  it("matches /rubbish as the dedicated Rubbish Bin Codex view", async () => {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: ["/rubbish"] }),
    });

    await router.load();

    expect(router.state.location.pathname).toBe("/rubbish");
    expect(router.state.matches.at(-1)?.routeId).toBe("/rubbish");
    expect(router.state.matches.at(-1)?.staticData.codexView).toBe("rubbish");
  });
});

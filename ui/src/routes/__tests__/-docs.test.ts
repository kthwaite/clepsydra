import {
  createMemoryHistory,
  createRouter,
  type Router,
} from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { routeTree } from "#/routeTree.gen";

async function loadDocsPath(path: string) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return router;
}

function expectDocsSlugMatch(router: Router<typeof routeTree>, slug: string) {
  const match = router.state.matches.find(
    (candidate) => candidate.routeId === "/docs/$slug",
  );
  expect(match?.params).toMatchObject({ slug });
}

describe("documentation file routes", () => {
  it("redirects the docs root to Getting Started", async () => {
    const router = await loadDocsPath("/docs");

    expect(router.state.location.pathname).toBe("/docs/getting-started");
    expect(router.state.location.hash).toBe("");
    expectDocsSlugMatch(router, "getting-started");
  });

  it("canonicalizes a trailing slash and preserves its fragment", async () => {
    const router = await loadDocsPath("/docs/#installation");

    expect(router.state.location.pathname).toBe("/docs/getting-started");
    expect(router.state.location.hash).toBe("installation");
    expectDocsSlugMatch(router, "getting-started");
  });

  it("preserves a fragment while redirecting the docs root", async () => {
    const router = await loadDocsPath("/docs#installation");

    expect(router.state.location.pathname).toBe("/docs/getting-started");
    expect(router.state.location.hash).toBe("installation");
    expectDocsSlugMatch(router, "getting-started");
  });

  it("keeps a valid guide deep link on its requested route", async () => {
    const router = await loadDocsPath("/docs/bases");

    expect(router.state.location.pathname).toBe("/docs/bases");
    expectDocsSlugMatch(router, "bases");
  });

  it("keeps an unknown guide URL matched for in-layout recovery", async () => {
    const router = await loadDocsPath("/docs/unknown-guide");

    expect(router.state.location.pathname).toBe("/docs/unknown-guide");
    expectDocsSlugMatch(router, "unknown-guide");
  });
});

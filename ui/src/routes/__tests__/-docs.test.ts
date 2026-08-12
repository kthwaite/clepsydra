import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRouter,
  type Router,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "#/components/ThemeProvider";
import { EncryptionProvider } from "#/crypto/EncryptionProvider";
import { DOC_PAGES } from "#/docs/registry";
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
  it("keeps guide components behind per-page lazy boundaries", () => {
    for (const page of DOC_PAGES) {
      expect(
        (page.Component as unknown as { $$typeof?: symbol }).$$typeof,
      ).toBe(Symbol.for("react.lazy"));
    }
  });

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

  it.each(DOC_PAGES)(
    "loads the registered $slug guide directly",
    async ({ slug }) => {
      const router = await loadDocsPath(`/docs/${slug}`);

      expect(router.state.location.pathname).toBe(`/docs/${slug}`);
      expectDocsSlugMatch(router, slug);
    },
  );

  it("loads a direct guide on a narrow viewport and navigates from its drawer", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query === "(max-width: 767px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    const router = await loadDocsPath("/docs/getting-started");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          EncryptionProvider,
          null,
          createElement(
            ThemeProvider,
            null,
            createElement(RouterProvider, { router }),
          ),
        ),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Getting Started" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Open documentation navigation",
      }),
    );
    const drawer = screen.getByRole("dialog", {
      name: "Documentation navigation",
    });
    await user.click(
      within(drawer).getByRole("link", { name: "Pages and Authoring" }),
    );

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/docs/pages-and-authoring");
      expect(
        screen.queryByRole("dialog", {
          name: "Documentation navigation",
        }),
      ).not.toBeInTheDocument();
    });
    vi.unstubAllGlobals();
  });

  it("keeps an unknown guide URL matched for in-layout recovery", async () => {
    const router = await loadDocsPath("/docs/unknown-guide");

    expect(router.state.location.pathname).toBe("/docs/unknown-guide");
    expectDocsSlugMatch(router, "unknown-guide");
  });
});

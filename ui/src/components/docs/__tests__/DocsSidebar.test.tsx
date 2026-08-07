import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocsSidebar } from "#/components/docs/DocsSidebar";
import { DOC_PAGES } from "#/docs/registry";
import { buildDocsIndex, searchDocs } from "#/docs/search";

function renderSidebar(
  props: { activeSlug?: string; onNavigate?: () => void } = {},
) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <DocsSidebar {...props} />,
  });
  const docsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/docs/$slug",
    component: () => <p>Guide destination</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, docsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(<RouterProvider router={router} />);
  return router;
}

describe("DocsSidebar", () => {
  it("renders the six-page hierarchy, active marker, and collapsible groups", async () => {
    const user = userEvent.setup();
    renderSidebar({ activeSlug: "getting-started" });

    const navigation = await screen.findByRole("navigation", {
      name: "Documentation",
    });
    expect(
      within(navigation).getByRole("link", { name: "Getting Started" }),
    ).toHaveAttribute("aria-current", "page");
    expect(within(navigation).getAllByRole("link")).toHaveLength(6);

    const startHere = within(navigation).getByRole("button", {
      name: "Start Here",
    });
    expect(startHere).toHaveAttribute("aria-expanded", "true");
    await user.click(startHere);
    expect(startHere).toHaveAttribute("aria-expanded", "false");
    expect(
      within(navigation).queryByRole("link", { name: "Getting Started" }),
    ).not.toBeInTheDocument();
  });

  it("replaces groups with ranked snippets for a query and restores them when cleared", async () => {
    const user = userEvent.setup();
    renderSidebar({ activeSlug: "getting-started" });

    const searchbox = await screen.findByRole("searchbox", {
      name: "Search documentation",
    });
    await user.type(searchbox, "typed fields");

    expect(screen.queryByText("Start Here")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Bases/ })).toBeInTheDocument();
    expect(screen.getByText(/typed fields/i)).toBeInTheDocument();

    await user.clear(searchbox);
    expect(screen.getByText("Start Here")).toBeInTheDocument();
  });

  it("shows the exact empty result state and clears back to grouped navigation", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.type(
      await screen.findByRole("searchbox", {
        name: "Search documentation",
      }),
      "term-that-cannot-exist",
    );

    expect(screen.getByText("No documentation matches")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Clear documentation search" }),
    );
    expect(screen.getByText("Start Here")).toBeInTheDocument();
  });

  it("preserves ranked result order and heading hashes", async () => {
    const user = userEvent.setup();
    renderSidebar();

    await user.type(
      await screen.findByRole("searchbox", {
        name: "Search documentation",
      }),
      "setup",
    );

    const results = screen.getByRole("list", { name: "Search results" });
    const hrefs = within(results)
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    const expectedHrefs = searchDocs(buildDocsIndex(DOC_PAGES), "setup").map(
      (result) =>
        `/docs/${result.page.slug}${result.headingId ? `#${result.headingId}` : ""}`,
    );
    expect(hrefs).toEqual(expectedHrefs);
    expect(hrefs).toContain("/docs/lsp#setup-neovim-011");
  });

  it("calls onNavigate after grouped and search-result selections", async () => {
    const user = userEvent.setup();
    const onNavigate = vi.fn();
    const router = renderSidebar({ onNavigate });

    await user.click(
      await screen.findByRole("link", { name: "Getting Started" }),
    );
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/docs/getting-started");
    });
    expect(onNavigate).toHaveBeenCalledTimes(1);

    await router.navigate({ to: "/" });
    await user.type(
      await screen.findByRole("searchbox", {
        name: "Search documentation",
      }),
      "typed fields",
    );
    await user.click(screen.getByRole("link", { name: /Bases/ }));
    expect(onNavigate).toHaveBeenCalledTimes(2);
  });
});

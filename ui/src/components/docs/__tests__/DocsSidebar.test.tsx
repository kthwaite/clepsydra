import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DocsSidebar } from "#/components/docs/DocsSidebar";
import { DOC_PAGES } from "#/docs/registry";
import { buildDocsIndex, searchDocs } from "#/docs/search";

function renderSidebar(
  props: { activeSlug?: string; onNavigate?: () => void } = {},
  initialEntry = "/",
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
    component: () => <DocsSidebar {...props} />,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, docsRoute]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
  });

  render(<RouterProvider router={router} />);
  return router;
}

describe("DocsSidebar", () => {
  it("renders all user-intent groups with accessible collapsible navigation", async () => {
    const user = userEvent.setup();
    renderSidebar({ activeSlug: "getting-started" });

    const navigation = await screen.findByRole("navigation", {
      name: "Documentation",
    });
    const groupButtons = within(navigation)
      .getAllByRole("button")
      .filter((button) => button.hasAttribute("aria-expanded"));
    expect(groupButtons.map((button) => button.textContent?.trim())).toEqual([
      "Start",
      "Pages and authoring",
      "Links and structured knowledge",
      "Work and reading",
      "Capture, feeds, and archives",
      "AI and integrations",
      "Operations and reference",
    ]);
    for (const button of groupButtons) {
      expect(button).toHaveAttribute("aria-expanded", "true");
      const panelId = button.getAttribute("aria-controls");
      expect(panelId).not.toBeNull();
      expect(button.id).not.toBe("");
      expect(document.getElementById(panelId ?? "")).toHaveAttribute(
        "aria-labelledby",
        button.id,
      );
    }

    expect(within(navigation).getAllByRole("link")).toHaveLength(9);
    expect(
      within(navigation).getByRole("link", { name: "Getting Started" }),
    ).toHaveAttribute("aria-current", "page");
    expect(
      within(navigation).getByRole("link", { name: "Troubleshooting" }),
    ).toHaveAttribute("href", "/docs/troubleshooting");
    expect(
      within(navigation).getByRole("link", { name: "Browser Extension" }),
    ).toHaveAttribute("href", "/docs/browser-extension");
    expect(
      within(navigation).getByRole("link", { name: "Books and Reading" }),
    ).toHaveAttribute("href", "/docs/books-and-reading");

    const start = groupButtons[0];
    await user.click(start);
    expect(start).toHaveAttribute("aria-expanded", "false");
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

    expect(screen.queryByText("Start")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Bases/ })).toBeInTheDocument();
    expect(screen.getByText(/typed fields/i)).toBeInTheDocument();

    await user.clear(searchbox);
    expect(screen.getByText("Start")).toBeInTheDocument();
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
    expect(screen.getByText("Start")).toBeInTheDocument();
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

  it("calls onNavigate only after accepted pathname and hash navigation", async () => {
    const user = userEvent.setup();
    const locationsAtNavigate: Array<{ pathname: string; hash: string }> = [];
    let readLocation = () => ({ pathname: "/", hash: "" });
    const onNavigate = vi.fn(() => {
      locationsAtNavigate.push(readLocation());
    });
    const router = renderSidebar({ onNavigate });
    readLocation = () => ({
      pathname: router.state.location.pathname,
      hash: router.state.location.hash,
    });
    const gettingStarted = await screen.findByRole("link", {
      name: "Getting Started",
    });

    fireEvent.click(gettingStarted, { ctrlKey: true });
    expect(onNavigate).not.toHaveBeenCalled();
    expect(router.state.location.pathname).toBe("/");

    await user.type(
      screen.getByRole("searchbox", { name: "Search documentation" }),
      "setup neovim",
    );
    await user.click(
      screen.getByRole("link", { name: /LSP.*Setup \(Neovim 0\.11\+\)/ }),
    );
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledTimes(1);
    });
    expect(locationsAtNavigate[0]).toEqual({
      pathname: "/docs/lsp",
      hash: "setup-neovim-011",
    });

    await user.type(
      await screen.findByRole("searchbox", {
        name: "Search documentation",
      }),
      "setup neovim",
    );
    await user.click(
      screen.getByRole("link", { name: /LSP.*Setup \(Neovim 0\.11\+\)/ }),
    );
    await waitFor(() => {
      expect(onNavigate).toHaveBeenCalledTimes(2);
    });
    expect(locationsAtNavigate[1]).toEqual(locationsAtNavigate[0]);
  });

  it("marks at most the exact pathname and hash result current", async () => {
    const user = userEvent.setup();
    renderSidebar({ activeSlug: "lsp" }, "/docs/lsp#setup-neovim-011");

    await user.type(
      await screen.findByRole("searchbox", {
        name: "Search documentation",
      }),
      "setup",
    );
    const results = screen.getByRole("list", { name: "Search results" });
    const currentResults = within(results)
      .getAllByRole("link")
      .filter((link) => link.getAttribute("aria-current") === "page");

    expect(currentResults).toHaveLength(1);
    expect(currentResults[0]).toHaveAttribute(
      "href",
      "/docs/lsp#setup-neovim-011",
    );
  });
});

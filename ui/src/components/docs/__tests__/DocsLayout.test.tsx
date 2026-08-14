import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocsLayout } from "#/components/docs/DocsLayout";
import type { DocTocEntry } from "#/docs/toc";

const desktopListeners = new Set<(event: MediaQueryListEvent) => void>();
let desktopMatches = false;

const TOC: readonly DocTocEntry[] = [
  { depth: 2, text: "Prerequisites", id: "prerequisites" },
  { depth: 3, text: "Install the binary", id: "install-the-binary" },
  { depth: 2, text: "Related", id: "related" },
];

function setDesktop(matches: boolean) {
  desktopMatches = matches;
  const event = { matches, media: "(min-width: 768px)" } as MediaQueryListEvent;
  for (const listener of desktopListeners) listener(event);
}

function renderLayout(
  docsLoadGate?: Promise<void>,
  toc?: readonly DocTocEntry[],
) {
  function RootLayout() {
    return (
      <DocsLayout toc={toc}>
        <div data-testid="stable-article-child">
          Article remains mounted
          <Outlet />
        </div>
      </DocsLayout>
    );
  }

  const rootRoute = createRootRoute({ component: RootLayout });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <p>Documentation home</p>,
  });
  const docsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/docs/$slug",
    beforeLoad: () => docsLoadGate,
    component: () => <p>Guide destination</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, docsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  const rendered = render(<RouterProvider router={router} />);
  return { ...rendered, router };
}

beforeEach(() => {
  desktopMatches = false;
  desktopListeners.clear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: desktopMatches,
      media: query,
      onchange: null,
      addEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => desktopListeners.add(listener),
      removeEventListener: (
        _type: string,
        listener: (event: MediaQueryListEvent) => void,
      ) => desktopListeners.delete(listener),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DocsLayout", () => {
  it("keeps the shell, rail, and article overflow boundaries explicit", async () => {
    renderLayout();

    const shell = await screen.findByTestId("docs-layout");
    const rail = screen.getByTestId("docs-desktop-rail");
    const article = screen.getByRole("main", {
      name: "Documentation article",
    });

    expect(shell).toHaveClass("h-full", "min-h-0", "overflow-hidden");
    expect(rail).toHaveClass("hidden", "md:flex", "overflow-y-auto");
    expect(article).toHaveClass("min-w-0", "overflow-y-auto");
    expect(
      within(rail).getByRole("navigation", { name: "Documentation" }),
    ).toBeInTheDocument();
  });

  it("dismisses the labeled drawer by Escape and scrim while preserving child identity and focus", async () => {
    const user = userEvent.setup();
    renderLayout();
    const child = await screen.findByTestId("stable-article-child");
    const trigger = screen.getByRole("button", {
      name: "Open documentation navigation",
    });

    await user.click(trigger);
    const dialog = screen.getByRole("dialog", {
      name: "Documentation navigation",
    });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
    expect(screen.getByTestId("stable-article-child")).toBe(child);

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Documentation navigation" }),
      ).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });

    await user.click(trigger);
    await user.click(screen.getByTestId("docs-drawer-overlay"));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Documentation navigation" }),
      ).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
    expect(screen.getByTestId("stable-article-child")).toBe(child);
  });

  it("transitions the route before a real heading result closes the drawer", async () => {
    const user = userEvent.setup();
    let releaseNavigation!: () => void;
    const navigationGate = new Promise<void>((resolve) => {
      releaseNavigation = resolve;
    });
    const { router } = renderLayout(navigationGate);
    const child = await screen.findByTestId("stable-article-child");

    await user.click(
      screen.getByRole("button", {
        name: "Open documentation navigation",
      }),
    );
    const dialog = screen.getByRole("dialog", {
      name: "Documentation navigation",
    });
    await user.type(
      within(dialog).getByRole("searchbox", {
        name: "Search documentation",
      }),
      "configure neovim",
    );
    const headingResult = within(dialog)
      .getAllByRole("link")
      .find(
        (link) =>
          link.getAttribute("href") ===
          "/docs/lsp#configure-neovim-011-or-newer",
      );
    expect(headingResult).toBeDefined();

    let locationAtClose: { pathname: string; hash: string } | undefined;
    const closeObserver = new MutationObserver(() => {
      if (!dialog.isConnected && !locationAtClose) {
        locationAtClose = {
          pathname: router.state.location.pathname,
          hash: router.state.location.hash,
        };
      }
    });
    closeObserver.observe(document.body, { childList: true, subtree: true });

    await user.click(headingResult as HTMLAnchorElement);
    expect(dialog).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/docs/lsp");
    expect(router.state.location.hash).toBe("configure-neovim-011-or-newer");

    releaseNavigation();
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Documentation navigation" }),
      ).not.toBeInTheDocument();
      expect(locationAtClose).toEqual({
        pathname: "/docs/lsp",
        hash: "configure-neovim-011-or-newer",
      });
    });
    closeObserver.disconnect();
    expect(screen.getByTestId("stable-article-child")).toBe(child);
  });

  it("closes and uninerts on a narrow-to-desktop transition, focusing the visible article", async () => {
    const user = userEvent.setup();
    renderLayout();
    await screen.findByTestId("stable-article-child");
    await user.click(
      screen.getByRole("button", {
        name: "Open documentation navigation",
      }),
    );
    const article = screen.getByRole("main", {
      name: "Documentation article",
      hidden: true,
    });
    expect(article.closest("[aria-hidden='true'], [inert]")).not.toBeNull();

    act(() => setDesktop(true));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Documentation navigation" }),
      ).not.toBeInTheDocument();
      expect(article).toHaveFocus();
      expect(article.closest("[aria-hidden='true'], [inert]")).toBeNull();
    });
  });

  describe("on this page", () => {
    // jsdom has no Element scroll implementation; entry clicks only need it
    // to exist, since the article geometry is zero here either way
    const proto = HTMLElement.prototype as HTMLElement & {
      scrollTo: (opts: ScrollToOptions) => void;
    };
    const origScrollTo = proto.scrollTo;

    beforeEach(() => {
      proto.scrollTo = vi.fn();
    });

    afterEach(() => {
      proto.scrollTo = origScrollTo;
    });

    it("gives the guide its own heading rail beside the article", async () => {
      renderLayout(undefined, TOC);
      await screen.findByTestId("stable-article-child");

      const rail = screen.getByTestId("docs-toc-rail");
      expect(rail).toHaveClass("hidden", "xl:flex", "overflow-y-auto");
      expect(
        within(rail).getByRole("navigation", { name: "On this page" }),
      ).toBeInTheDocument();
      expect(
        within(rail)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(TOC.map((entry) => entry.text));
    });

    it("omits the rail for a guide with no headings", async () => {
      renderLayout();
      await screen.findByTestId("stable-article-child");

      expect(screen.queryByTestId("docs-toc-rail")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("navigation", { name: "On this page" }),
      ).not.toBeInTheDocument();
    });

    it("closes the drawer when a heading is chosen from it", async () => {
      const user = userEvent.setup();
      renderLayout(undefined, TOC);
      await screen.findByTestId("stable-article-child");

      await user.click(
        screen.getByRole("button", {
          name: "Open documentation navigation",
        }),
      );
      const dialog = screen.getByRole("dialog", {
        name: "Documentation navigation",
      });
      const drawerToc = within(dialog).getByRole("navigation", {
        name: "On this page",
      });
      expect(
        within(dialog).getByRole("navigation", { name: "Documentation" }),
      ).toBeInTheDocument();

      await user.click(
        within(drawerToc).getByRole("button", { name: "Related" }),
      );

      await waitFor(() => {
        expect(
          screen.queryByRole("dialog", { name: "Documentation navigation" }),
        ).not.toBeInTheDocument();
      });
    });
  });
});

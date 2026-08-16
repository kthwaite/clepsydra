import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import type { components } from "#/api/schema";
import { ArchiveBanner } from "#/components/codex/ArchiveBanner";

type ArchiveMeta = components["schemas"]["ArchiveMetaResponse"];

const archive = {
  domain: "example.com",
  url: "https://example.com/article",
  captured_at: "2026-08-01T12:00:00Z",
  site_name: "Example",
  byline: null,
  published_time: null,
  snapshot_hash: "sha256:abc",
} as ArchiveMeta;

const COLLAPSE_KEY = "clepsydra.archive-banner-collapsed";

function renderBanner() {
  const rootRoute = createRootRoute({ component: Outlet });
  const bannerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ArchiveBanner
        title="Example Article"
        path="archive/example.com/example-article.md"
        archive={archive}
      />
    ),
  });
  const pagesRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/pages/$",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([bannerRoute, pagesRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  return render(<RouterProvider router={router} />);
}

describe("ArchiveBanner collapse", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("renders expanded by default with provenance details", async () => {
    renderBanner();

    expect(
      await screen.findByRole("heading", { name: "Example Article" }),
    ).toBeVisible();
    expect(screen.getByText("Captured")).toBeVisible();
    expect(
      screen.getByRole("button", { name: /collapse archive banner/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("collapse hides provenance but keeps title strip and back link", async () => {
    const user = userEvent.setup();
    renderBanner();

    await user.click(
      await screen.findByRole("button", { name: /collapse archive banner/i }),
    );

    expect(screen.queryByText("Captured")).not.toBeInTheDocument();
    expect(screen.getByText("Example Article")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "← Back to vault page" }),
    ).toBeVisible();
    const toggle = screen.getByRole("button", {
      name: /expand archive banner/i,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("collapse state persists via localStorage", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(COLLAPSE_KEY, "1");
    renderBanner();

    expect(
      await screen.findByRole("button", { name: /expand archive banner/i }),
    ).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Captured")).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /expand archive banner/i }),
    );

    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe("0");
    expect(
      screen.getByRole("button", { name: /collapse archive banner/i }),
    ).toHaveAttribute("aria-expanded", "true");
  });
});

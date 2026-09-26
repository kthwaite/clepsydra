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

function renderBanner(meta: ArchiveMeta = archive) {
  const rootRoute = createRootRoute({ component: Outlet });
  const bannerRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => (
      <ArchiveBanner
        title="Example Article"
        path="archive/example.com/example-article.md"
        archive={meta}
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

  it("stacks title and provenance on phones so neither squeezes to nothing", async () => {
    renderBanner();

    const heading = await screen.findByRole("heading", {
      name: "Example Article",
    });
    // Long titles truncate; the full title stays available on hover.
    expect(heading).toHaveAttribute("title", "Example Article");
    const body = heading.closest("div.grid");
    expect(body).toHaveClass("grid-cols-1");
    expect(body).toHaveClass("md:grid-cols-[minmax(0,1fr)_auto]");
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
      screen.getByRole("link", { name: "Back to vault page" }),
    ).toBeVisible();
    const toggle = screen.getByRole("button", {
      name: /expand archive banner/i,
    });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).not.toHaveTextContent("[+]");
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

describe("ArchiveBanner provenance", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("lists provenance as a description list with fixed-month dates", async () => {
    const capturedAt = new Date(2026, 8, 18, 14, 2, 11).toISOString();
    renderBanner({
      ...archive,
      captured_at: capturedAt,
      byline: "Iris Calder",
      published_time: "2026-09-17",
    });

    await screen.findByRole("heading", { name: "Example Article" });
    const terms = screen.getAllByRole("term").map((el) => el.textContent);
    expect(terms).toEqual(["Captured", "Site", "Byline", "Published"]);
    const values = screen
      .getAllByRole("definition")
      .map((el) => el.textContent);
    expect(values).toEqual([
      "18 Sep 2026, 14:02",
      "Example",
      "Iris Calder",
      "17 Sep 2026",
    ]);
    expect(screen.getByText("18 Sep 2026, 14:02")).toHaveAttribute(
      "dateTime",
      capturedAt,
    );
    expect(screen.getByText("17 Sep 2026")).toHaveAttribute(
      "dateTime",
      "2026-09-17",
    );
  });

  it("shows the domain eyebrow and the live link without a glyph arrow", async () => {
    renderBanner();

    expect(await screen.findByText("Archive · example.com")).toBeVisible();
    const live = screen.getByRole("link", {
      name: "Open live page: https://example.com/article",
    });
    expect(live).toHaveAttribute("href", "https://example.com/article");
    expect(live).not.toHaveTextContent("↗");
    expect(screen.queryByText("[–]")).not.toBeInTheDocument();
  });

  it("keeps an unsafe live URL as sentence-case invalid metadata", async () => {
    renderBanner({ ...archive, url: "javascript:alert(1)" });

    const note = await screen.findByText("Invalid archive URL metadata");
    expect(note.closest("p")).toHaveClass("text-hot");
    expect(note).not.toHaveClass("uppercase");
    expect(screen.getByText("javascript:alert(1)")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /open live page/i }),
    ).not.toBeInTheDocument();
  });
});

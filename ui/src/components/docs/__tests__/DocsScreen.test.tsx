import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocsScreen } from "#/components/docs/DocsScreen";
import { DOC_PAGES } from "#/docs/registry";
import { extractDocToc } from "#/docs/toc";

function RoutedDocsScreen() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  return <DocsScreen slug={slug} />;
}

function renderDocsPath(path: string) {
  const rootRoute = createRootRoute();
  const docsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/docs/$slug",
    component: RoutedDocsScreen,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([docsRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });

  return { ...render(<RouterProvider router={router} />), router };
}

describe("DocsScreen", () => {
  it("renders a deep-linked guide and marks its sidebar entry current", async () => {
    renderDocsPath("/docs/bases");

    expect(
      await screen.findByRole("heading", { level: 1, name: "Bases" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Bases" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("lists the guide's own headings, in rendered order, beside it", async () => {
    const page = DOC_PAGES.find((candidate) => candidate.slug === "bases");
    const entries = extractDocToc(page?.source ?? "");
    expect(entries.length).toBeGreaterThan(0);

    renderDocsPath("/docs/bases");

    const rail = await screen.findByTestId("docs-toc-rail");
    expect(
      within(rail)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(entries.map((entry) => entry.text));

    // the rail's order is only useful if it matches the article's headings
    const article = await screen.findByRole("article");
    await waitFor(() =>
      expect(
        [...article.querySelectorAll("h2,h3,h4,h5,h6")].map(
          (heading) => heading.id,
        ),
      ).toEqual(entries.map((entry) => entry.id)),
    );
  });

  it("keeps documentation navigation around an unknown-guide recovery", async () => {
    renderDocsPath("/docs/unknown-guide");

    expect(
      await screen.findByRole("heading", { name: "Documentation not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Getting Started" }),
    ).toHaveAttribute("href", "/docs/getting-started");

    expect(screen.queryByTestId("docs-toc-rail")).not.toBeInTheDocument();

    const navigation = screen.getByRole("navigation", {
      name: "Documentation",
    });
    expect(navigation).toBeInTheDocument();
    expect(
      within(navigation).getByRole("link", { name: "Getting Started" }),
    ).not.toHaveAttribute("aria-current");
  });
});

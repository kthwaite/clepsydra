import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
  useParams,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DocsScreen } from "#/components/docs/DocsScreen";

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

  it("keeps documentation navigation around an unknown-guide recovery", async () => {
    renderDocsPath("/docs/unknown-guide");

    expect(
      await screen.findByRole("heading", { name: "Documentation not found" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Open Getting Started" }),
    ).toHaveAttribute("href", "/docs/getting-started");

    const navigation = screen.getByRole("navigation", {
      name: "Documentation",
    });
    expect(navigation).toBeInTheDocument();
    expect(
      within(navigation).getByRole("link", { name: "Getting Started" }),
    ).not.toHaveAttribute("aria-current");
  });
});

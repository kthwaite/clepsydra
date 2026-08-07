import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentPropsWithoutRef, ElementType } from "react";
import type { MDXComponents } from "mdx/types";
import { describe, expect, it } from "vitest";
import { DocsArticle } from "#/components/docs/DocsArticle";
import type { DocPage } from "#/docs/types";

function FixtureGuide({ components = {} }: { components?: MDXComponents }) {
  const H2 = (components.h2 ?? "h2") as ElementType<
    ComponentPropsWithoutRef<"h2">
  >;
  const Anchor = (components.a ?? "a") as ElementType<
    ComponentPropsWithoutRef<"a">
  >;
  const Paragraph = (components.p ?? "p") as ElementType<
    ComponentPropsWithoutRef<"p">
  >;
  const Pre = (components.pre ?? "pre") as ElementType<
    ComponentPropsWithoutRef<"pre">
  >;
  const Code = (components.code ?? "code") as ElementType<
    ComponentPropsWithoutRef<"code">
  >;
  const Table = (components.table ?? "table") as ElementType<
    ComponentPropsWithoutRef<"table">
  >;
  const Th = (components.th ?? "th") as ElementType<
    ComponentPropsWithoutRef<"th">
  >;
  const Td = (components.td ?? "td") as ElementType<
    ComponentPropsWithoutRef<"td">
  >;

  return (
    <>
      <H2 id="fields">Fields</H2>
      <Paragraph>
        <Anchor href="#fields">Jump to fields</Anchor>
        {" · "}
        <Anchor href="/docs/bases#fields">Bases</Anchor>
        {" · "}
        <Anchor href="https://example.com">External</Anchor>
      </Paragraph>
      <Pre>
        <Code className="language-ts">const field = true;</Code>
      </Pre>
      <Table>
        <thead>
          <tr>
            <Th>Field</Th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <Td>title</Td>
          </tr>
        </tbody>
      </Table>
    </>
  );
}

const page: DocPage = {
  slug: "getting-started",
  title: "Getting started",
  description: "Set up Clepsydra and create your first vault.",
  groupId: "start",
  source: "",
  Component: FixtureGuide,
};

function renderArticle(articlePage: DocPage = page) {
  const rootRoute = createRootRoute({ component: Outlet });
  const articleRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <DocsArticle page={articlePage} />,
  });
  const docsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/docs/$slug",
    component: () => <p>Destination guide</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([articleRoute, docsRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(<RouterProvider router={router} />);
  return router;
}

describe("DocsArticle", () => {
  it("renders the article hierarchy and section permalinks", async () => {
    renderArticle();

    expect(
      await screen.findByRole("heading", { level: 1, name: page.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(page.description)).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: /breadcrumb/i }),
    ).toHaveTextContent("Start Here");

    const heading = screen.getByRole("heading", { level: 2, name: /Fields/ });
    expect(heading).toHaveAttribute("id", "fields");
    expect(
      screen.getByRole("link", { name: /link to fields section/i }),
    ).toHaveAttribute("href", "#fields");
  });

  it("routes docs links internally while preserving fragments and external safety", async () => {
    const user = userEvent.setup();
    const router = renderArticle();
    await screen.findByRole("heading", { level: 1, name: page.title });

    expect(screen.getByRole("link", { name: "Jump to fields" })).toHaveAttribute(
      "href",
      "#fields",
    );
    expect(screen.getByRole("link", { name: "Bases" })).toHaveAttribute(
      "href",
      "/docs/bases#fields",
    );
    expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("link", { name: "External" })).toHaveAttribute(
      "rel",
      "noreferrer",
    );

    await user.click(screen.getByRole("link", { name: "Bases" }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/docs/bases");
      expect(router.state.location.hash).toBe("fields");
    });
  });

  it("renders copyable code, semantic tables, and registry navigation", async () => {
    renderArticle();
    await screen.findByRole("heading", { level: 1, name: page.title });

    expect(
      screen.getByRole("button", { name: /copy code/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("region", { name: "Scrollable table" }),
    ).toHaveAttribute("tabindex", "0");
    expect(
      screen.getByRole("link", { name: /Next: Configuration/i }),
    ).toHaveAttribute("href", "/docs/configuration");
    expect(
      screen.queryByRole("link", { name: /Previous:/i }),
    ).not.toBeInTheDocument();
  });
});

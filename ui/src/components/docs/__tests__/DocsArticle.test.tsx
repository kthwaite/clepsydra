import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen } from "@testing-library/react";
import type { MDXComponents } from "mdx/types";
import { describe, expect, it } from "vitest";
import { DocsArticle } from "#/components/docs/DocsArticle";
import type { DocPage } from "#/docs/types";

function FixtureGuide({ components = {} }: { components?: MDXComponents }) {
  const H2 = components.h2 ?? "h2";
  const Anchor = components.a ?? "a";
  const Paragraph = components.p ?? "p";
  const Pre = components.pre ?? "pre";
  const Code = components.code ?? "code";
  const Table = components.table ?? "table";
  const Th = components.th ?? "th";
  const Td = components.td ?? "td";

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
  const router = createRouter({
    routeTree: rootRoute.addChildren([articleRoute]),
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
    renderArticle();
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
  });

  it("renders copyable code, semantic tables, and registry navigation", async () => {
    renderArticle();
    await screen.findByRole("heading", { level: 1, name: page.title });

    expect(
      screen.getByRole("button", { name: /copy code/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Next: Configuration/i }),
    ).toHaveAttribute("href", "/docs/configuration");
    expect(
      screen.queryByRole("link", { name: /Previous:/i }),
    ).not.toBeInTheDocument();
  });
});

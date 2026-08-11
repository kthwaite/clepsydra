import { expect, it } from "vitest";
import { DEFAULT_DOC_SLUG } from "#/docs/constants";
import {
  DOC_GROUPS,
  DOC_PAGES,
  getDocNeighbors,
  getDocPage,
} from "#/docs/registry";

it("declares the approved hierarchy and unique slugs", () => {
  expect(
    DOC_GROUPS.map((group) => [group.label, group.pages.map((p) => p.slug)]),
  ).toEqual([
    ["Start Here", ["getting-started", "configuration", "troubleshooting"]],
    ["Reference", ["cli"]],
    ["Features", ["bases", "books-and-reading", "recipes"]],
    ["Integrations", ["lsp", "mcp", "browser-extension"]],
  ]);
  expect(new Set(DOC_PAGES.map((page) => page.slug)).size).toBe(
    DOC_PAGES.length,
  );
  expect(getDocPage(DEFAULT_DOC_SLUG)?.title).toBe("Getting Started");
});

it("resolves the dedicated troubleshooting and browser extension guides", () => {
  expect(getDocPage("troubleshooting")).toMatchObject({
    slug: "troubleshooting",
    title: "Troubleshooting",
  });
  expect(getDocPage("browser-extension")).toMatchObject({
    slug: "browser-extension",
    title: "Browser Extension",
  });
  expect(getDocPage("books-and-reading")).toMatchObject({
    slug: "books-and-reading",
    title: "Books and Reading",
  });
  expect(getDocPage("recipes")).toMatchObject({
    slug: "recipes",
    title: "Recipes",
  });
});

it("derives previous and next guides from registry order", () => {
  expect(getDocNeighbors("getting-started").previous).toBeUndefined();
  expect(getDocNeighbors("getting-started").next?.slug).toBe("configuration");
  expect(getDocNeighbors("configuration")).toMatchObject({
    previous: { slug: "getting-started" },
    next: { slug: "troubleshooting" },
  });
  expect(getDocNeighbors("troubleshooting")).toMatchObject({
    previous: { slug: "configuration" },
    next: { slug: "cli" },
  });
  expect(getDocNeighbors("books-and-reading")).toMatchObject({
    previous: { slug: "bases" },
    next: { slug: "recipes" },
  });
  expect(getDocNeighbors("recipes")).toMatchObject({
    previous: { slug: "books-and-reading" },
    next: { slug: "lsp" },
  });
  expect(getDocNeighbors("lsp").previous?.slug).toBe("recipes");
  expect(getDocNeighbors("mcp").previous?.slug).toBe("lsp");
  expect(getDocNeighbors("mcp").next?.slug).toBe("browser-extension");
  expect(getDocNeighbors("browser-extension").previous?.slug).toBe("mcp");
  expect(getDocNeighbors("browser-extension").next).toBeUndefined();
});

it("keeps MDX metadata and registry entries aligned", () => {
  for (const page of DOC_PAGES) {
    expect(page.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(page.title).not.toBe("");
    expect(page.description).not.toBe("");
    expect(page.source).toContain(`slug: "${page.slug}"`);
  }
});

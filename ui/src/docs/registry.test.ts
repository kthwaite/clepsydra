import { expect, it } from "vitest";
import { DEFAULT_DOC_SLUG } from "#/docs/constants";
import {
  DOC_GROUPS,
  DOC_PAGES,
  getDocNeighbors,
  getDocPage,
} from "#/docs/registry";

it("declares the approved user-intent hierarchy", () => {
  expect(
    DOC_GROUPS.map((group) => [
      group.label,
      group.pages.map((page) => page.slug),
    ]),
  ).toEqual([
    ["Start", ["getting-started"]],
    ["Pages and authoring", []],
    ["Links and structured knowledge", ["bases"]],
    ["Work and reading", ["books-and-reading"]],
    ["Capture, feeds, and archives", ["browser-extension"]],
    ["AI and integrations", ["lsp", "mcp"]],
    [
      "Operations and reference",
      ["configuration", "troubleshooting", "cli"],
    ],
  ]);
});

it("registers each existing guide exactly once with discovery metadata", () => {
  expect(DOC_PAGES).toHaveLength(9);
  expect(new Set(DOC_PAGES.map((page) => page.slug)).size).toBe(
    DOC_PAGES.length,
  );
  expect(new Set(DOC_PAGES.map((page) => page.title)).size).toBe(
    DOC_PAGES.length,
  );

  for (const group of DOC_GROUPS) {
    for (const page of group.pages) {
      expect(page.groupId).toBe(group.id);
      expect(page.description.trim()).not.toBe("");
      expect(page.keywords.length).toBeGreaterThan(0);
      expect(page.keywords.every((keyword) => keyword.trim().length > 0)).toBe(
        true,
      );
    }
  }

  expect(getDocPage(DEFAULT_DOC_SLUG)?.title).toBe("Getting Started");
});

it("resolves every existing dedicated guide", () => {
  expect(DOC_PAGES.map((page) => page.slug)).toEqual([
    "getting-started",
    "bases",
    "books-and-reading",
    "browser-extension",
    "lsp",
    "mcp",
    "configuration",
    "troubleshooting",
    "cli",
  ]);
  expect(getDocPage("troubleshooting")?.title).toBe("Troubleshooting");
  expect(getDocPage("browser-extension")?.title).toBe("Browser Extension");
  expect(getDocPage("books-and-reading")?.title).toBe("Books and Reading");
});

it("derives previous and next guides across group boundaries", () => {
  expect(getDocNeighbors("getting-started")).toMatchObject({
    next: { slug: "bases" },
  });
  expect(getDocNeighbors("getting-started").previous).toBeUndefined();
  expect(getDocNeighbors("bases")).toMatchObject({
    previous: { slug: "getting-started" },
    next: { slug: "books-and-reading" },
  });
  expect(getDocNeighbors("books-and-reading")).toMatchObject({
    previous: { slug: "bases" },
    next: { slug: "browser-extension" },
  });
  expect(getDocNeighbors("browser-extension")).toMatchObject({
    previous: { slug: "books-and-reading" },
    next: { slug: "lsp" },
  });
  expect(getDocNeighbors("mcp")).toMatchObject({
    previous: { slug: "lsp" },
    next: { slug: "configuration" },
  });
  expect(getDocNeighbors("configuration")).toMatchObject({
    previous: { slug: "mcp" },
    next: { slug: "troubleshooting" },
  });
  expect(getDocNeighbors("cli").previous?.slug).toBe("troubleshooting");
  expect(getDocNeighbors("cli").next).toBeUndefined();
});

it("keeps MDX metadata and registry entries aligned", () => {
  for (const page of DOC_PAGES) {
    expect(page.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(page.title).not.toBe("");
    expect(page.source).toContain(`slug: "${page.slug}"`);
  }
});

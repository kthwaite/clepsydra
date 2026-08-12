import { expect, it } from "vitest";
import { DEFAULT_DOC_SLUG } from "#/docs/constants";
import {
  DOC_GROUPS,
  DOC_PAGES,
  getDocNeighbors,
  getDocPage,
} from "#/docs/registry";

const WORKFLOW_GUIDE_SLUGS = [
  "pages-and-authoring",
  "editor-workflows",
  "attachments-and-media",
  "encryption-and-protected-pages",
] as const;

const KNOWLEDGE_GUIDE_SLUGS = [
  "links-search-graph-and-repair",
  "block-references-and-transclusion",
  "bases",
] as const;

const WORK_READING_GUIDE_SLUGS = [
  "tasks-agenda-journals-and-board",
  "academic-library-and-reading",
  "books-and-reading",
] as const;

const CAPTURE_GUIDE_SLUGS = [
  "capture-feeds-and-archives",
  "browser-extension",
] as const;

const AI_INTEGRATION_GUIDE_SLUGS = [
  "codex-and-conversation-capture",
  "lsp",
  "mcp",
] as const;

it("declares the approved user-intent hierarchy", () => {
  expect(
    DOC_GROUPS.map((group) => [
      group.label,
      group.pages.map((page) => page.slug),
    ]),
  ).toEqual([
    ["Start", ["getting-started"]],
    ["Pages and authoring", [...WORKFLOW_GUIDE_SLUGS]],
    ["Links and structured knowledge", [...KNOWLEDGE_GUIDE_SLUGS]],
    ["Work and reading", [...WORK_READING_GUIDE_SLUGS]],
    ["Capture, feeds, and archives", [...CAPTURE_GUIDE_SLUGS]],
    ["AI and integrations", [...AI_INTEGRATION_GUIDE_SLUGS]],
    [
      "Operations and reference",
      ["configuration", "troubleshooting", "cli", "api-reference"],
    ],
  ]);
});

it("registers each existing guide exactly once with discovery metadata", () => {
  expect(DOC_PAGES).toHaveLength(20);
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
    ...WORKFLOW_GUIDE_SLUGS,
    ...KNOWLEDGE_GUIDE_SLUGS,
    ...WORK_READING_GUIDE_SLUGS,
    ...CAPTURE_GUIDE_SLUGS,
    ...AI_INTEGRATION_GUIDE_SLUGS,
    "configuration",
    "troubleshooting",
    "cli",
    "api-reference",
  ]);
  expect(getDocPage("links-search-graph-and-repair")?.title).toBe(
    "Links, Search, Graph, and Repair",
  );
  expect(getDocPage("block-references-and-transclusion")?.title).toBe(
    "Block References and Transclusion",
  );
  expect(getDocPage("troubleshooting")?.title).toBe("Troubleshooting");
  expect(getDocPage("browser-extension")?.title).toBe("Browser Extension");
  expect(getDocPage("books-and-reading")?.title).toBe("Books and Reading");
  expect(getDocPage("api-reference")?.title).toBe("API Reference");
});

it("derives previous and next guides across group boundaries", () => {
  expect(getDocNeighbors("getting-started")).toMatchObject({
    next: { slug: "pages-and-authoring" },
  });
  expect(getDocNeighbors("getting-started").previous).toBeUndefined();
  expect(getDocNeighbors("pages-and-authoring")).toMatchObject({
    previous: { slug: "getting-started" },
    next: { slug: "editor-workflows" },
  });
  expect(getDocNeighbors("encryption-and-protected-pages")).toMatchObject({
    previous: { slug: "attachments-and-media" },
    next: { slug: "links-search-graph-and-repair" },
  });
  expect(getDocNeighbors("links-search-graph-and-repair")).toMatchObject({
    previous: { slug: "encryption-and-protected-pages" },
    next: { slug: "block-references-and-transclusion" },
  });
  expect(getDocNeighbors("block-references-and-transclusion")).toMatchObject({
    previous: { slug: "links-search-graph-and-repair" },
    next: { slug: "bases" },
  });
  expect(getDocNeighbors("bases")).toMatchObject({
    previous: { slug: "block-references-and-transclusion" },
    next: { slug: "tasks-agenda-journals-and-board" },
  });
  expect(getDocNeighbors("tasks-agenda-journals-and-board")).toMatchObject({
    previous: { slug: "bases" },
    next: { slug: "academic-library-and-reading" },
  });
  expect(getDocNeighbors("academic-library-and-reading")).toMatchObject({
    previous: { slug: "tasks-agenda-journals-and-board" },
    next: { slug: "books-and-reading" },
  });
  expect(getDocNeighbors("books-and-reading")).toMatchObject({
    previous: { slug: "academic-library-and-reading" },
    next: { slug: "capture-feeds-and-archives" },
  });
  expect(getDocNeighbors("capture-feeds-and-archives")).toMatchObject({
    previous: { slug: "books-and-reading" },
    next: { slug: "browser-extension" },
  });
  expect(getDocNeighbors("browser-extension")).toMatchObject({
    previous: { slug: "capture-feeds-and-archives" },
    next: { slug: "codex-and-conversation-capture" },
  });
  expect(getDocNeighbors("codex-and-conversation-capture")).toMatchObject({
    previous: { slug: "browser-extension" },
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
  expect(getDocNeighbors("cli")).toMatchObject({
    previous: { slug: "troubleshooting" },
    next: { slug: "api-reference" },
  });
  expect(getDocNeighbors("api-reference").previous?.slug).toBe("cli");
  expect(getDocNeighbors("api-reference").next).toBeUndefined();
});

it("keeps MDX metadata and registry entries aligned", () => {
  for (const page of DOC_PAGES) {
    expect(page.slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(page.title).not.toBe("");
    expect(page.source).toContain(`slug: "${page.slug}"`);
  }
});

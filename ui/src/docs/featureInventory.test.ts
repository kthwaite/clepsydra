import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";
import { STATIC_COMMANDS } from "#/components/codex/commandRegistry";
import { FEATURE_INVENTORY } from "#/docs/featureInventory";
import { DOC_GROUPS, DOC_PAGES } from "#/docs/registry";
import { routeTree } from "#/routeTree.gen";

const REQUIRED_WORKFLOW_IDS = [
  "workflow.pages-editor",
  "workflow.folders-moves-deletes",
  "workflow.search",
  "workflow.wikilinks-backlinks",
  "workflow.graph",
  "workflow.block-references-transclusion",
  "workflow.bases",
  "workflow.tasks",
  "workflow.agenda",
  "workflow.journals",
  "workflow.board-cycles",
  "workflow.academic-import",
  "workflow.academic-library",
  "workflow.reading",
  "workflow.feeds",
  "workflow.browser-capture",
  "workflow.archive-cas",
  "workflow.attachments",
  "workflow.encryption",
  "workflow.codex",
  "workflow.conversation-capture",
  "workflow.lsp",
  "workflow.mcp",
  "workflow.browser-extension",
  "workflow.configuration",
  "workflow.diagnostics",
  "workflow.backup",
] as const;

const WORKFLOW_GUIDE_ASSIGNMENTS = {
  "workflow.tasks": "tasks-agenda-journals-and-board",
  "workflow.agenda": "tasks-agenda-journals-and-board",
  "workflow.journals": "tasks-agenda-journals-and-board",
  "workflow.board-cycles": "tasks-agenda-journals-and-board",
  "workflow.academic-import": "academic-library-and-reading",
  "workflow.academic-library": "academic-library-and-reading",
  "workflow.reading": "academic-library-and-reading",
  "workflow.feeds": "capture-feeds-and-archives",
  "workflow.browser-capture": "capture-feeds-and-archives",
  "workflow.archive-cas": "capture-feeds-and-archives",
  "workflow.backup": "capture-feeds-and-archives",
} as const;

const TASK_6_GUIDE_ASSIGNMENTS = {
  "workflow.codex": "codex-and-conversation-capture",
  "workflow.conversation-capture": "codex-and-conversation-capture",
  "workflow.lsp": "lsp",
  "workflow.mcp": "mcp",
  "workflow.browser-extension": "browser-extension",
} as const;

function routePaths(): string[] {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return Object.values(router.routesById)
    .filter((route) => route.id !== "__root__")
    .map((route) => route.fullPath);
}

describe("feature documentation inventory", () => {
  it("gives every navigable route exactly one documentation disposition", () => {
    expect(
      FEATURE_INVENTORY.filter((entry) => entry.surface === "route")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(routePaths().sort());
  });

  it("gives every static command exactly one documentation disposition", () => {
    expect(
      FEATURE_INVENTORY.filter((entry) => entry.surface === "command")
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(STATIC_COMMANDS.map((command) => command.id).sort());
  });

  it("includes every current major named workflow without marking it internal", () => {
    const entriesById = new Map(
      FEATURE_INVENTORY.map((entry) => [entry.id, entry]),
    );

    expect(
      REQUIRED_WORKFLOW_IDS.filter((id) => !entriesById.has(id)),
    ).toEqual([]);
    expect(
      REQUIRED_WORKFLOW_IDS.filter(
        (id) => entriesById.get(id)?.disposition.kind === "internal",
      ),
    ).toEqual([]);
  });

  it("maps work, reading, capture, feed, archive, and backup workflows to their dedicated guides", () => {
    const entriesById: ReadonlyMap<string, (typeof FEATURE_INVENTORY)[number]> =
      new Map(FEATURE_INVENTORY.map((entry) => [entry.id, entry]));

    for (const [id, slug] of Object.entries(WORKFLOW_GUIDE_ASSIGNMENTS)) {
      expect(entriesById.get(id)?.disposition).toEqual({
        kind: "guide",
        slug,
      });
    }
  });

  it("maps Codex, conversation capture, and integrations to their dedicated guides", () => {
    const entriesById: ReadonlyMap<
      string,
      (typeof FEATURE_INVENTORY)[number]
    > = new Map(FEATURE_INVENTORY.map((entry) => [entry.id, entry]));

    for (const [id, slug] of Object.entries(TASK_6_GUIDE_ASSIGNMENTS)) {
      expect(entriesById.get(id)?.disposition).toEqual({
        kind: "guide",
        slug,
      });
    }
  });

  it("maps every integration manifest entry to a registered structured guide", () => {
    const integrations = FEATURE_INVENTORY.filter(
      (entry) => entry.surface === "integration",
    );
    for (const integration of integrations) {
      expect(integration.disposition.kind).toBe("guide");
    }
    const integrationSlugs = [
      ...new Set(
        integrations.flatMap((entry) =>
          entry.disposition.kind === "guide"
            ? [entry.disposition.slug]
            : [],
        ),
      ),
    ];

    expect(integrationSlugs.length).toBeGreaterThan(0);
    for (const slug of integrationSlugs) {
      const source = DOC_PAGES.find((page) => page.slug === slug)?.source;
      expect(source, `${slug} must be registered`).toBeDefined();
      for (const heading of [
        "Prerequisites",
        "Workflow",
        "Failures and conflicts",
        "Privacy",
        "Related",
      ]) {
        expect(source).toMatch(new RegExp(`^## ${heading}$`, "m"));
      }
      expect(source).toContain("(/docs/configuration)");
      expect(source).toContain("(/docs/troubleshooting)");
    }
  });

  it("classifies persistent appearance controls as user-facing configuration", () => {
    const appearanceCommandIds = [
      "app.settings",
      "app.themeToggle",
      "sys.chrome",
    ];

    expect(
      FEATURE_INVENTORY.filter((entry) =>
        appearanceCommandIds.includes(entry.id),
      ).map((entry) => [entry.id, entry.disposition]),
    ).toEqual(
      appearanceCommandIds.map((id) => [
        id,
        { kind: "reference", slug: "configuration" },
      ]),
    );
  });

  it("uses unique inventory IDs", () => {
    const ids = FEATURE_INVENTORY.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("uses only registered documentation slugs", () => {
    const registeredSlugs = new Set(DOC_PAGES.map((page) => page.slug));
    const unknownSlugs = FEATURE_INVENTORY.flatMap((entry) =>
      entry.disposition.kind === "internal" ||
      registeredSlugs.has(entry.disposition.slug)
        ? []
        : [entry.disposition.slug],
    );

    expect(unknownSlugs).toEqual([]);
  });

  it("uses one concrete disposition shape and explains internal entries", () => {
    for (const entry of FEATURE_INVENTORY) {
      if (entry.disposition.kind === "internal") {
        expect(Object.keys(entry.disposition).sort()).toEqual([
          "kind",
          "rationale",
        ]);
        expect(entry.disposition.rationale.trim()).not.toBe("");
      } else {
        expect(Object.keys(entry.disposition).sort()).toEqual(["kind", "slug"]);
      }
    }
  });

  it("does not treat a Next or Later page as current documentation", () => {
    const roadmapSlugs = new Set(
      DOC_GROUPS.filter((group) => /^(next|later)$/i.test(group.label)).flatMap(
        (group) => group.pages.map((page) => page.slug),
      ),
    );
    const roadmapClaims = FEATURE_INVENTORY.flatMap((entry) =>
      entry.disposition.kind !== "internal" &&
      roadmapSlugs.has(entry.disposition.slug)
        ? [entry.id]
        : [],
    );

    expect(roadmapClaims).toEqual([]);
  });
});

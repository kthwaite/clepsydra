import { describe, expect, it } from "vitest";
import { DOC_PAGES } from "#/docs/registry";
import { buildDocsIndex, searchDocs } from "#/docs/search";
import type { DocPage } from "#/docs/types";

const NoopDoc = () => null;

const gettingStarted = {
  slug: "getting-started",
  title: "Getting Started",
  description: "Set up a local vault.",
  keywords: ["setup", "vault"],
  groupId: "start-here",
  source: `export const meta = {
  slug: "getting-started",
  searchOnlyMetadata: "metadataonly"
}

Read the [linked words](https://example.com) and **bold text** first.

## Initialize a vault

Initialize the workspace from your terminal.

\`\`\`bash
metadataonly hiddenfence
\`\`\`
`,
  Component: NoopDoc,
} satisfies DocPage;

const bases = {
  slug: "bases",
  title: "Bases",
  description: "Work with structured records.",
  keywords: ["records", "fields"],
  groupId: "features",
  source: `import {
  unusedFixtureValue
} from "./fixture"

export const meta = {
  slug: "bases"
}

A compact record guide.

## Fields

Typed **fields** store structured values.

~~~ts
const hiddenfence = "typed fields"
~~~

## Fields

Computed values derive from formulas.
`,
  Component: NoopDoc,
} satisfies DocPage;

function page(
  slug: string,
  title: string,
  description: string,
  source: string,
): DocPage {
  return {
    slug,
    title,
    description,
    keywords: [slug],
    groupId: "test",
    source,
    Component: NoopDoc,
  };
}

describe("buildDocsIndex", () => {
  it("extracts page and heading sections in registry order with rehype-compatible duplicate slugs", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(
      index.map(({ page: entry, heading, headingId }) => [
        entry.slug,
        heading,
        headingId,
      ]),
    ).toEqual([
      ["getting-started", undefined, undefined],
      ["getting-started", "Initialize a vault", "initialize-a-vault"],
      ["bases", undefined, undefined],
      ["bases", "Fields", "fields"],
      ["bases", "Fields", "fields-1"],
    ]);
    expect(index.map((section) => section.order)).toEqual([0, 1, 2, 3, 4]);
  });

  it("removes metadata, fenced code, links, and inline formatting from indexed body text", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(index[0]?.text).toContain(
      "Read the linked words and bold text first.",
    );
    expect(index.some((section) => section.text.includes("metadataonly"))).toBe(
      false,
    );
    expect(index.some((section) => section.text.includes("hiddenfence"))).toBe(
      false,
    );
    expect(index.some((section) => /\[|\]|\*\*/.test(section.text))).toBe(
      false,
    );
  });

  it("uses rendered heading text for slugs and excludes MDX ESM without dropping prose", () => {
    const semantic = page(
      "semantic",
      "Semantic guide",
      "Unrelated",
      `export const metadata = {
  delimiter: "}",
  hidden: "esmsecret"
}

export const other =
  "secondsecret"

import: prosevisible remains searchable.

## Use \`foo_bar\` &amp; [Docs][docs]

Visible body.

    indentedcodesecret

## ![Icon](icon.svg) Setup

Image heading body.

[docs]: https://example.com
`,
    );
    const index = buildDocsIndex([semantic]);

    expect(index.map(({ heading, headingId }) => [heading, headingId])).toEqual(
      [
        [undefined, undefined],
        ["Use foo_bar & Docs", "use-foo_bar--docs"],
        ["Setup", "-setup"],
      ],
    );
    expect(searchDocs(index, "prosevisible")).toHaveLength(1);
    expect(searchDocs(index, "esmsecret")).toEqual([]);
    expect(searchDocs(index, "secondsecret")).toEqual([]);
    expect(searchDocs(index, "indentedcodesecret")).toEqual([]);
  });
});

describe("searchDocs", () => {
  it.each([
    {
      query: "attaches then stops",
      expected: {
        page: { slug: "troubleshooting" },
        heading: "Neovim LSP fails to initialize or attaches then stops",
        headingId: "neovim-lsp-fails-to-initialize-or-attaches-then-stops",
      },
    },
    {
      query: "notification only conflict behavior",
      expected: {
        page: { slug: "browser-extension" },
        heading: "Content Changed conflict",
        headingId: "content-changed-conflict",
      },
    },
    {
      query: "no bulk apply",
      expected: {
        page: { slug: "links-search-graph-and-repair" },
        heading: "Preview, apply, and stale conflicts",
        headingId: "preview-apply-and-stale-conflicts",
      },
    },
    {
      query: "protected and missing targets indistinguishable",
      expected: {
        page: { slug: "block-references-and-transclusion" },
        heading: "Privacy boundary for protected folios",
        headingId: "privacy-boundary-for-protected-folios",
      },
    },
    {
      query: "all original cycle task files restored",
      expected: {
        page: { slug: "tasks-agenda-journals-and-board" },
        heading: "Create, start, and close Cycles",
        headingId: "create-start-and-close-cycles",
      },
    },
    {
      query: "local date defines boundaries",
      expected: {
        page: { slug: "tasks-agenda-journals-and-board" },
        heading: "Use Overdue, Today, Upcoming, and Undated",
        headingId: "use-overdue-today-upcoming-and-undated",
      },
    },
    {
      query: "whole Zotero BibTeX run not one",
      expected: {
        page: { slug: "academic-library-and-reading" },
        heading: "Import BibTeX, DOI, ISBN, and Zotero",
        headingId: "import-bibtex-doi-isbn-and-zotero",
      },
    },
    {
      query: "timestamped uncompressed tar consistent snapshot",
      expected: {
        page: { slug: "capture-feeds-and-archives" },
        heading: "Back up and recover shipped state",
        headingId: "back-up-and-recover-shipped-state",
      },
    },
    {
      query: "self-assembling research context",
      expected: {
        page: { slug: "codex-and-conversation-capture" },
        heading: "Work with tabs, quires, and previews",
        headingId: "work-with-tabs-quires-and-previews",
      },
    },
  ])(
    "finds distinctive dedicated-guide content for $query",
    ({ query, expected }) => {
      const result = searchDocs(buildDocsIndex(DOC_PAGES), query)[0];

      expect(result).toMatchObject(expected);
    },
  );

  it.each([
    ["stale repair", "links-search-graph-and-repair"],
    ["protected attachment", "attachments-and-media"],
    ["board carryover", "tasks-agenda-journals-and-board"],
    ["zotero conflict", "academic-library-and-reading"],
    ["block transclusion", "block-references-and-transclusion"],
    ["MCP server", "mcp"],
    ["CAS archive", "capture-feeds-and-archives"],
  ])("ranks the canonical guide first for %s", (query, expectedSlug) => {
    expect(searchDocs(buildDocsIndex(DOC_PAGES), query)[0]?.page.slug).toBe(
      expectedSlug,
    );
  });

  it("deduplicates a page while retaining its best heading deep link", () => {
    const repeated = page(
      "repeated-sections",
      "Repeated sections",
      "Unrelated",
      [
        "## First match",
        "",
        "Needle appears here.",
        "",
        "## Second match",
        "",
        "Needle appears here too.",
      ].join("\n"),
    );

    expect(searchDocs(buildDocsIndex([repeated]), "needle")).toEqual([
      expect.objectContaining({
        page: repeated,
        heading: "First match",
        headingId: "first-match",
      }),
    ]);
  });

  it("requires every normalized query token in the same section", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(
      searchDocs(index, "typed fields").map((result) => result.page.slug),
    ).toEqual(["bases"]);
    expect(searchDocs(index, "typed formulas")).toEqual([]);
    expect(searchDocs(index, "missing token")).toEqual([]);
  });

  it("ranks title matches ahead of heading, description, keywords, and body matches", () => {
    const bodyMatch = page(
      "body",
      "Body guide",
      "Unrelated guide",
      "The needle appears in body copy.",
    );
    const keywordMatch = {
      ...page("keyword", "Keyword guide", "Unrelated guide", "Unrelated copy."),
      keywords: ["needle"],
    };
    const descriptionMatch = page(
      "description",
      "Description guide",
      "Needle reference",
      "Unrelated copy.",
    );
    const headingMatch = page(
      "heading",
      "Heading guide",
      "Unrelated guide",
      "## Needle\n\nUnrelated copy.",
    );
    const titleMatch = page(
      "title",
      "Needle",
      "Unrelated guide",
      "Unrelated copy.",
    );

    const results = searchDocs(
      buildDocsIndex([
        bodyMatch,
        keywordMatch,
        descriptionMatch,
        headingMatch,
        titleMatch,
      ]),
      "needle",
    );

    expect(results.map((result) => result.page.slug)).toEqual([
      "title",
      "heading",
      "description",
      "keyword",
      "body",
    ]);
    expect(results.map((result) => result.score)).toEqual([
      11_000, 300, 100, 50, 10,
    ]);
    expect(searchDocs(buildDocsIndex([titleMatch]), "need")[0]?.score).toBe(
      6_000,
    );
  });

  it("finds a registry guide by keyword and uses its description excerpt", () => {
    expect(
      searchDocs(buildDocsIndex(DOC_PAGES), "database").map(
        (result) => result.page.slug,
      ),
    ).toContain("bases");
    expect(searchDocs(buildDocsIndex(DOC_PAGES), "database")[0]).toEqual(
      expect.objectContaining({
        page: expect.objectContaining({ slug: "bases" }),
        heading: undefined,
        headingId: undefined,
        excerpt: "Build saved, non-owning views over typed folio properties.",
        score: 50,
      }),
    );
  });

  it("returns one page-level result when metadata alone satisfies the query", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(searchDocs(index, "bases")).toEqual([
      expect.objectContaining({
        page: bases,
        heading: undefined,
        headingId: undefined,
      }),
    ]);
  });

  it("prefers a specific section over a same-class page-body duplicate", () => {
    const repeated = page(
      "repeated",
      "Repeated guide",
      "Unrelated",
      "Needle in the introduction.\n\n## Details\n\nNeedle in the details.",
    );

    expect(searchDocs(buildDocsIndex([repeated]), "needle")).toEqual([
      expect.objectContaining({
        page: repeated,
        heading: "Details",
        headingId: "details",
        score: 10,
      }),
    ]);
  });

  it("returns the section result for a heading match", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(searchDocs(index, "initialize")[0]).toMatchObject({
      page: gettingStarted,
      heading: "Initialize a vault",
      headingId: "initialize-a-vault",
    });
  });

  it("folds query case and returns no results for an empty normalized query", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(searchDocs(index, "InItIaLiZe")[0]?.headingId).toBe(
      "initialize-a-vault",
    );
    expect(searchDocs(index, "   ---   ")).toEqual([]);
  });

  it("does not match terms that occur only in metadata or fenced code", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(searchDocs(index, "metadataonly")).toEqual([]);
    expect(searchDocs(index, "hiddenfence")).toEqual([]);
  });

  it("breaks equal-score ties by registry and section order", () => {
    const first = page(
      "first",
      "First",
      "Unrelated",
      "Needle in the first page.",
    );
    const second = page(
      "second",
      "Second",
      "Unrelated",
      "Needle in the second page.",
    );

    expect(
      searchDocs(buildDocsIndex([first, second]), "needle").map(
        (result) => result.page.slug,
      ),
    ).toEqual(["first", "second"]);
  });

  it("builds a readable excerpt of at most 140 characters around the first body match", () => {
    const longBody = `${"Earlier context ".repeat(12)}DistinctiveNeedle ${"later context ".repeat(12)}`;
    const result = searchDocs(
      buildDocsIndex([page("excerpt", "Excerpt guide", "Unrelated", longBody)]),
      "distinctiveneedle",
    )[0];

    expect(result?.excerpt).toContain("DistinctiveNeedle");
    expect(result?.excerpt.length).toBeLessThanOrEqual(140);
    expect(result?.excerpt.startsWith("…")).toBe(true);
    expect(result?.excerpt.endsWith("…")).toBe(true);
  });

  it("positions description excerpts with the same whole-string Unicode normalization used for ranking", () => {
    const description = `${"Earlier description context ".repeat(8)}ΟΣ`;
    const result = searchDocs(
      buildDocsIndex([page("unicode", "Unicode guide", description, "")]),
      "ΟΣ",
    )[0];

    expect(result?.excerpt).toContain("ΟΣ");
    expect(result?.excerpt.length).toBeLessThanOrEqual(140);
    expect(result?.excerpt.startsWith("…")).toBe(true);
  });
});

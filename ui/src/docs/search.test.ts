import { describe, expect, it } from "vitest";
import { buildDocsIndex, searchDocs } from "#/docs/search";
import type { DocPage } from "#/docs/types";

const NoopDoc = () => null;

const gettingStarted = {
  slug: "getting-started",
  title: "Getting Started",
  description: "Set up a local vault.",
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
    groupId: "test",
    source,
    Component: NoopDoc,
  };
}

describe("buildDocsIndex", () => {
  it("extracts page and heading sections in registry order with rehype-compatible duplicate slugs", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(index.map(({ page: entry, heading, headingId }) => [entry.slug, heading, headingId])).toEqual([
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

    expect(index[0]?.text).toContain("Read the linked words and bold text first.");
    expect(index.some((section) => section.text.includes("metadataonly"))).toBe(false);
    expect(index.some((section) => section.text.includes("hiddenfence"))).toBe(false);
    expect(index.some((section) => /\[|\]|\*\*/.test(section.text))).toBe(false);
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

    expect(index.map(({ heading, headingId }) => [heading, headingId])).toEqual([
      [undefined, undefined],
      ["Use foo_bar & Docs", "use-foo_bar--docs"],
      ["Setup", "setup"],
    ]);
    expect(searchDocs(index, "prosevisible")).toHaveLength(1);
    expect(searchDocs(index, "esmsecret")).toEqual([]);
    expect(searchDocs(index, "secondsecret")).toEqual([]);
    expect(searchDocs(index, "indentedcodesecret")).toEqual([]);
  });
});

describe("searchDocs", () => {
  it("requires every normalized query token in the same section", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(searchDocs(index, "typed fields").map((result) => result.page.slug)).toEqual(["bases"]);
    expect(searchDocs(index, "typed formulas")).toEqual([]);
    expect(searchDocs(index, "missing token")).toEqual([]);
  });

  it("ranks title matches ahead of heading, description, and body matches", () => {
    const bodyMatch = page("body", "Body guide", "Unrelated guide", "The needle appears in body copy.");
    const descriptionMatch = page("description", "Description guide", "Needle reference", "Unrelated copy.");
    const headingMatch = page("heading", "Heading guide", "Unrelated guide", "## Needle\n\nUnrelated copy.");
    const titleMatch = page("title", "Needle", "Unrelated guide", "Unrelated copy.");

    const results = searchDocs(
      buildDocsIndex([bodyMatch, descriptionMatch, headingMatch, titleMatch]),
      "needle",
    );

    expect(results.map((result) => result.page.slug)).toEqual([
      "title",
      "heading",
      "description",
      "body",
    ]);
    expect(results.map((result) => result.score)).toEqual([11_000, 300, 100, 10]);
    expect(searchDocs(buildDocsIndex([titleMatch]), "need")[0]?.score).toBe(6_000);
  });

  it("returns one page-level result when metadata alone satisfies the query", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(searchDocs(index, "bases")).toEqual([
      expect.objectContaining({ page: bases, heading: undefined, headingId: undefined }),
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
      expect.objectContaining({ page: repeated, heading: "Details", headingId: "details", score: 10 }),
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

    expect(searchDocs(index, "InItIaLiZe")[0]?.headingId).toBe("initialize-a-vault");
    expect(searchDocs(index, "   ---   ")).toEqual([]);
  });

  it("does not match terms that occur only in metadata or fenced code", () => {
    const index = buildDocsIndex([gettingStarted, bases]);

    expect(searchDocs(index, "metadataonly")).toEqual([]);
    expect(searchDocs(index, "hiddenfence")).toEqual([]);
  });

  it("breaks equal-score ties by registry and section order", () => {
    const first = page("first", "First", "Unrelated", "Needle in the first page.");
    const second = page("second", "Second", "Unrelated", "Needle in the second page.");

    expect(
      searchDocs(buildDocsIndex([first, second]), "needle").map((result) => result.page.slug),
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

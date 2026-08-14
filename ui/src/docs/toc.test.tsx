import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DOC_PAGES } from "#/docs/registry";
import { extractDocToc } from "#/docs/toc";

const FIXTURE = `export const meta = {
  slug: "fixture"
}

# Page title

Intro prose.

## Initialize a vault

Body text.

### Use \`clep init\` &amp; [Docs][docs]

More body.

##    Spaced    heading

## ![Icon](icon.svg) Setup

[docs]: https://example.com
`;

const INDENTED_FIXTURE = `Body text.

    ## Indented pseudo heading

## Real heading
`;

const DUPLICATE_FIXTURE = `## Fields

Typed fields.

## Fields

Computed fields.

## Fields
`;

describe("extractDocToc", () => {
  it("captures depth, semantic text, and slug id for each top-level heading", () => {
    expect(extractDocToc(FIXTURE)).toEqual([
      { depth: 2, text: "Initialize a vault", id: "initialize-a-vault" },
      { depth: 3, text: "Use clep init & Docs", id: "use-clep-init--docs" },
      // text is whitespace-collapsed for display; the slug is not, so it
      // stays byte-identical to the one rehype-slug derives from the DOM
      { depth: 2, text: "Spaced heading", id: "spaced----heading" },
      { depth: 2, text: "Setup", id: "-setup" },
    ]);
  });

  it("skips the depth-1 title heading", () => {
    expect(extractDocToc(FIXTURE).some((entry) => entry.depth === 1)).toBe(
      false,
    );
    expect(extractDocToc("# Only a title\n")).toEqual([]);
  });

  it("skips indented-code pseudo headings", () => {
    expect(extractDocToc(INDENTED_FIXTURE)).toEqual([
      { depth: 2, text: "Real heading", id: "real-heading" },
    ]);
  });

  it("disambiguates repeated heading text the way rehype-slug does", () => {
    expect(extractDocToc(DUPLICATE_FIXTURE).map((entry) => entry.id)).toEqual([
      "fields",
      "fields-1",
      "fields-2",
    ]);
  });

  it("resets slug disambiguation for every call", () => {
    expect(extractDocToc(DUPLICATE_FIXTURE)).toEqual(
      extractDocToc(DUPLICATE_FIXTURE),
    );
  });
});

describe("documentation heading agreement", () => {
  it.each(DOC_PAGES)(
    "matches every rendered heading id in $slug",
    async ({ title, source, Component }) => {
      const { container, unmount } = render(
        // mirrors DocsArticle: the page title is an h1 outside the compiled MDX
        <article>
          <h1>{title}</h1>
          <Component />
        </article>,
      );
      await waitFor(() => expect(container).not.toBeEmptyDOMElement());

      const article = container.querySelector("article");
      const renderedIds = [
        ...(article?.querySelectorAll("h2,h3,h4,h5,h6") ?? []),
      ].map((heading) => heading.id);

      expect(renderedIds).toEqual(
        extractDocToc(source).map((entry) => entry.id),
      );
      unmount();
    },
  );
});

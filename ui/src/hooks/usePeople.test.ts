import { describe, expect, it } from "vitest";
import type { PageSummary } from "#/api/types";
import { findPageByName, pageName } from "#/hooks/usePeople";

function page(over: Partial<PageSummary> & { path: string }): PageSummary {
  return {
    id: over.path,
    aliases: [],
    canonical_name: over.path.replace(/^.*\//, "").replace(/\.md$/, ""),
    computed_tags: [],
    encrypted: false,
    inferred: false,
    kind: "NOTE",
    tags: [],
    ...over,
  };
}

const ada = page({
  path: "people/ada.md",
  title: "Ada Lovelace",
  aliases: ["Ada"],
  kind: "PERSON",
});
const adaNote = page({ path: "notes/ada-lovelace.md", title: "Ada Lovelace" });
const grace = page({
  path: "people/grace.md",
  title: "Grace Hopper",
  kind: "PERSON",
});

describe("pageName", () => {
  it("prefers the title and falls back to the canonical name", () => {
    expect(pageName(ada)).toBe("Ada Lovelace");
    expect(pageName(page({ path: "people/turing.md" }))).toBe("turing");
  });
});

describe("findPageByName", () => {
  it("matches the way a wikilink resolves: title, alias, case-insensitive", () => {
    expect(findPageByName([grace, ada], "ada lovelace")).toBe(ada);
    expect(findPageByName([grace, ada], "Ada")).toBe(ada);
    expect(findPageByName([grace, ada], "  Grace Hopper ")).toBe(grace);
  });

  it("prefers a PERSON page when another kind shares the name", () => {
    expect(findPageByName([adaNote, ada], "Ada Lovelace")).toBe(ada);
    expect(findPageByName([adaNote], "Ada Lovelace")).toBe(adaNote);
  });

  it("returns null for a name no page carries", () => {
    expect(findPageByName([grace, ada], "Alan Turing")).toBeNull();
    expect(findPageByName([grace, ada], "")).toBeNull();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { PageSummary } from "#/api/types";
import {
  normalizeWikilinkIdentity,
  pageHasExactWikilinkIdentity,
} from "../wikilinkIdentity";

const page: PageSummary = {
  id: "p1",
  title: "Design Notes",
  canonical_name: "design-notes",
  aliases: ["Blueprint"],
  path: "notes/design-notes.md",
  kind: "NOTE",
  inferred: true,
  encrypted: false,
  tags: [],
  computed_tags: [],
};

describe("normalizeWikilinkIdentity", () => {
  it("normalizes case, whitespace, and an optional Markdown suffix", () => {
    expect(normalizeWikilinkIdentity("  CAFÉ   Notes.md ")).toBe("café notes");
  });

  it("normalizes canonically equivalent Unicode", () => {
    expect(normalizeWikilinkIdentity("Cafe\u0301 Notes")).toBe("café notes");
  });

  it("uses locale-independent casing for Turkish-I-sensitive text", () => {
    const localeLowercase = vi
      .spyOn(String.prototype, "toLocaleLowerCase")
      .mockReturnValue("\u{131}dea");

    try {
      expect(normalizeWikilinkIdentity("IDEA")).toBe("idea");
      expect(localeLowercase).not.toHaveBeenCalled();
    } finally {
      localeLowercase.mockRestore();
    }
  });
});

describe("pageHasExactWikilinkIdentity", () => {
  it.each([
    ["title", " DESIGN NOTES "],
    ["canonical name", "design-notes"],
    ["alias", "blueprint"],
    ["path without suffix", "notes/design-notes"],
    ["path with suffix", "notes/design-notes.md"],
  ])("matches the page %s", (_field, query) => {
    expect(pageHasExactWikilinkIdentity(page, query)).toBe(true);
  });

  it("does not treat a partial identity as exact", () => {
    expect(pageHasExactWikilinkIdentity(page, "design")).toBe(false);
  });

  it("does not treat an empty query as exact", () => {
    expect(pageHasExactWikilinkIdentity(page, "   ")).toBe(false);
  });

  it("handles a page without an aliases array without throwing", () => {
    const pageWithoutAliases = {
      ...page,
      aliases: undefined as unknown as string[],
    };
    expect(
      pageHasExactWikilinkIdentity(pageWithoutAliases, "design-notes"),
    ).toBe(true);
  });
});

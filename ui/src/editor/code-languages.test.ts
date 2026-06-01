import { describe, expect, it } from "vitest";
import {
  COMMON_LANGUAGES,
  displayLabel,
  filterLanguages,
  listLanguageIds,
} from "#/editor/code-languages";

describe("code-languages", () => {
  it("displayLabel uppercases the id", () => {
    expect(displayLabel("rust")).toBe("RUST");
    expect(displayLabel("tsx")).toBe("TSX");
  });

  it("listLanguageIds pins registered common languages first, in order", () => {
    const ids = listLanguageIds();
    const expectedCommon = COMMON_LANGUAGES.filter((id) => ids.includes(id));
    expect(ids.slice(0, expectedCommon.length)).toEqual(expectedCommon);
  });

  it("listLanguageIds has no duplicates", () => {
    const ids = listLanguageIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("listLanguageIds includes well-known grammars", () => {
    const ids = listLanguageIds();
    expect(ids).toContain("rust");
    expect(ids).toContain("javascript");
  });

  it("filterLanguages('') returns the full ordering", () => {
    expect(filterLanguages("")).toEqual(listLanguageIds());
  });

  it("filterLanguages matches case-insensitive substrings", () => {
    expect(filterLanguages("RUS")).toContain("rust");
  });

  it("filterLanguages returns [] for no matches", () => {
    expect(filterLanguages("zzzznotalang")).toEqual([]);
  });
});

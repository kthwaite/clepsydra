import { describe, expect, it } from "vitest";
import {
  COMMON_LANGUAGES,
  CURATED_ALIASES,
  DIAGRAM_LANGUAGES,
  displayLabel,
  filterLanguages,
  listLanguageIds,
} from "#/editor/code-languages";
import { refractor } from "#/editor/refractor-languages";

describe("code-languages", () => {
  it("displayLabel uppercases the id", () => {
    expect(displayLabel("rust")).toBe("RUST");
    expect(displayLabel("tsx")).toBe("TSX");
  });

  it("listLanguageIds pins registered common languages first, in order", () => {
    const ids = listLanguageIds(refractor);
    const expectedCommon = COMMON_LANGUAGES.filter((id) => ids.includes(id));
    expect(ids.slice(0, expectedCommon.length)).toEqual(expectedCommon);
  });

  it("listLanguageIds has no duplicates", () => {
    const ids = listLanguageIds(refractor);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("listLanguageIds includes well-known grammars", () => {
    const ids = listLanguageIds(refractor);
    expect(ids).toContain("rust");
    expect(ids).toContain("javascript");
  });

  it("filterLanguages('') returns the full ordering", () => {
    expect(filterLanguages(refractor, "")).toEqual(listLanguageIds(refractor));
  });

  it("filterLanguages matches case-insensitive substrings", () => {
    expect(filterLanguages(refractor, "RUS")).toContain("rust");
  });

  it("filterLanguages returns [] for no matches", () => {
    expect(filterLanguages(refractor, "zzzznotalang")).toEqual([]);
  });

  it("collapses aliases to their canonical name", () => {
    const ids = listLanguageIds(refractor);
    expect(ids).toContain("javascript");
    expect(ids).not.toContain("js");
    expect(ids).not.toContain("ts");
  });

  it("registers tsx and jsx (curated commons absent from the base bundle)", () => {
    const ids = listLanguageIds(refractor);
    expect(ids).toContain("tsx");
    expect(ids).toContain("jsx");
  });

  it("excludes the plaintext family (the Plain text reset covers that)", () => {
    const ids = listLanguageIds(refractor);
    expect(ids).not.toContain("plaintext");
    expect(ids).not.toContain("txt");
    expect(ids).not.toContain("text");
    expect(ids).not.toContain("plain");
  });

  it("lists each grammar at most once (curated aliases excepted)", () => {
    const curated = new Set<string>([...CURATED_ALIASES, ...DIAGRAM_LANGUAGES]);
    const ids = listLanguageIds(refractor).filter((id) => !curated.has(id));
    const grammars = refractor.languages as Record<string, object>;
    const seen = new Set<object>();
    for (const id of ids) {
      const g = grammars[id];
      expect(seen.has(g)).toBe(false);
      seen.add(g);
    }
  });

  it("surfaces zsh as its own row sharing the bash grammar", () => {
    const ids = listLanguageIds(refractor);
    const grammars = refractor.languages as Record<string, object>;
    expect(ids).toContain("zsh");
    expect(ids).toContain("bash");
    // zsh has no dedicated Prism grammar — it reuses bash's.
    expect(grammars.zsh).toBe(grammars.bash);
  });

  it("filterLanguages finds zsh", () => {
    expect(filterLanguages(refractor, "zsh")).toContain("zsh");
  });

  it("offers mermaid even though refractor has no grammar for it", () => {
    const ids = listLanguageIds(refractor);
    const grammars = refractor.languages as Record<string, object>;
    expect(grammars.mermaid).toBeUndefined();
    expect(ids).toContain("mermaid");
    expect(filterLanguages(refractor, "merm")).toEqual(["mermaid"]);
  });

  it("falls back to the curated set while the grammar bundle loads", () => {
    expect(listLanguageIds(null)).toEqual([
      ...COMMON_LANGUAGES,
      ...DIAGRAM_LANGUAGES,
      ...CURATED_ALIASES,
    ]);
    expect(filterLanguages(null, "rus")).toEqual(["rust"]);
  });
});

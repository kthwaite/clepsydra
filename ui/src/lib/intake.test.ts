import { describe, expect, it } from "vitest";
import {
  generateShortId,
  intakePath,
  KIND_FOLDER,
  slugifyTitle,
} from "#/lib/intake";
import { KINDS } from "#/lib/kind";

describe("slugifyTitle", () => {
  // Vectors mirror the Rust tests in src/vault/path.rs so the two
  // implementations cannot drift silently.
  it("matches the backend slug rules", () => {
    expect(slugifyTitle("Redesign Retro!")).toBe("redesign-retro");
    expect(slugifyTitle("  Multiple   Spaces  ")).toBe("multiple-spaces");
    expect(slugifyTitle("abcdefghij", 5)).toBe("abcde");
    expect(slugifyTitle("ab cd ef", 5)).toBe("ab-cd");
    expect(slugifyTitle("")).toBe("untitled");
    expect(slugifyTitle("!!!")).toBe("untitled");
  });

  it("collapses non-ascii characters to dashes", () => {
    expect(slugifyTitle("café au lait")).toBe("caf-au-lait");
  });
});

describe("generateShortId", () => {
  it("emits 8 base62 chars", () => {
    expect(generateShortId()).toMatch(/^[0-9A-Za-z]{8}$/);
  });

  it("varies between calls", () => {
    const ids = new Set(Array.from({ length: 100 }, generateShortId));
    expect(ids.size).toBeGreaterThan(90);
  });
});

describe("intakePath", () => {
  const now = new Date(Date.UTC(2026, 4, 31, 12, 0, 0));

  it("projects kind folder + canonical filename", () => {
    expect(
      intakePath({
        kind: "NOTE",
        project: null,
        title: "Redesign Retro",
        shortId: "3kF9a2bQ",
        now,
      }),
    ).toBe("notes/20260531.redesign-retro.3kF9a2bQ.md");
  });

  it("inserts the project subfolder when set", () => {
    expect(
      intakePath({
        kind: "QUOTE",
        project: "clepsydra",
        title: "On Time",
        shortId: "aaaa0000",
        now,
      }),
    ).toBe("quotes/clepsydra/20260531.on-time.aaaa0000.md");
  });

  it("treats an empty project as absent", () => {
    expect(
      intakePath({
        kind: "NOTE",
        project: "  ",
        title: "x",
        shortId: "aaaa0000",
        now,
      }),
    ).toBe("notes/20260531.x.aaaa0000.md");
  });

  it("has a folder for every kind", () => {
    for (const k of KINDS) {
      expect(KIND_FOLDER[k]).toMatch(/^[a-z]+$/);
    }
  });
});

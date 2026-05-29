import { describe, expect, it } from "vitest";
import {
  KIND_META,
  KINDS,
  kindColorVar,
  kindLabel,
  parseFrontmatterKind,
  resolveKind,
  resolveKindFromPath,
} from "#/lib/kind";

describe("resolveKindFromPath", () => {
  it("maps known top-level folders to kinds (case-insensitive)", () => {
    expect(resolveKindFromPath("daily/2026-05-29.md")).toBe("DAILY");
    expect(resolveKindFromPath("projects/vessel.md")).toBe("PROJECT");
    expect(resolveKindFromPath("People/kit.md")).toBe("PERSON");
    expect(resolveKindFromPath("reading/some-book.md")).toBe("BOOK");
    expect(resolveKindFromPath("tasks/x.md")).toBe("TASK");
  });

  it("tolerates leading slashes and nested paths", () => {
    expect(resolveKindFromPath("/journal/2026/05/29.md")).toBe("DAILY");
  });

  it("falls back to NOTE for unknown or rootless paths", () => {
    expect(resolveKindFromPath("scratch.md")).toBe("NOTE");
    expect(resolveKindFromPath("misc/whatever.md")).toBe("NOTE");
    expect(resolveKindFromPath("")).toBe("NOTE");
  });
});

describe("parseFrontmatterKind", () => {
  it("reads a `type` key from leading YAML frontmatter", () => {
    const body = "---\ntype: project\ntitle: X\n---\n# heading\n";
    expect(parseFrontmatterKind(body)).toBe("PROJECT");
  });

  it("also accepts a `kind` key", () => {
    expect(parseFrontmatterKind("---\nkind: Task\n---\nbody")).toBe("TASK");
  });

  it("returns null when there is no frontmatter", () => {
    expect(parseFrontmatterKind("# just a heading\n")).toBeNull();
  });

  it("returns null for an unrecognized type value", () => {
    expect(parseFrontmatterKind("---\ntype: banana\n---\n")).toBeNull();
  });
});

describe("resolveKind", () => {
  it("prefers an explicit kind field (future backend support)", () => {
    expect(resolveKind({ path: "daily/x.md", kind: "BOOK" })).toBe("BOOK");
  });

  it("prefers frontmatter over folder", () => {
    expect(
      resolveKind({ path: "daily/x.md", body: "---\ntype: project\n---\n" }),
    ).toBe("PROJECT");
  });

  it("falls back to folder, then NOTE", () => {
    expect(resolveKind({ path: "daily/x.md" })).toBe("DAILY");
    expect(resolveKind({ path: "scratch.md" })).toBe("NOTE");
  });
});

describe("KIND_META", () => {
  it("has a label and color var for every kind", () => {
    for (const k of KINDS) {
      expect(KIND_META[k].label.length).toBeGreaterThan(0);
      expect(kindColorVar(k)).toMatch(/^var\(--/);
      expect(kindLabel(k)).toBe(KIND_META[k].label);
    }
  });
});

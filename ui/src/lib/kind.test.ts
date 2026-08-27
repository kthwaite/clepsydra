import { describe, expect, it } from "vitest";
import {
  ASSIGNABLE_KINDS,
  KIND_META,
  KINDS,
  kindColorVar,
  kindLabel,
  parseFrontmatterKind,
  resolveKind,
  resolveKindFromPath,
  sortKindsByLabel,
} from "#/lib/kind";
import type { Kind } from "#/lib/kind";

describe("resolveKindFromPath", () => {
  it("maps known top-level folders to kinds (case-insensitive)", () => {
    expect(resolveKindFromPath("daily/2026-05-29.md")).toBe("JOURNAL");
    expect(resolveKindFromPath("journals/2026-05-29.md")).toBe("JOURNAL");
    expect(resolveKindFromPath("projects/vessel.md")).toBe("PROJECT");
    expect(resolveKindFromPath("People/kit.md")).toBe("PERSON");
    expect(resolveKindFromPath("reading/some-book.md")).toBe("BOOK");
    // "tasks" moved from TODO to the TASK kind with the tasking board
    // (mirrors Kind::from_folder in src/vault/kind.rs); "todos" stays TODO.
    expect(resolveKindFromPath("tasks/x.md")).toBe("TASK");
    expect(resolveKindFromPath("todos/x.md")).toBe("TODO");
    expect(resolveKindFromPath("cycles/S-13.md")).toBe("CYCLE");
    expect(resolveKindFromPath("conversations/example.md")).toBe(
      "AI_CONVERSATION",
    );
    expect(resolveKindFromPath("conversation/example.md")).toBe(
      "AI_CONVERSATION",
    );
    expect(resolveKindFromPath("chats/example.md")).toBe("AI_CONVERSATION");
    expect(resolveKindFromPath("recipes/pho-ga.md")).toBe("RECIPE");
    expect(resolveKindFromPath("recipe/pho-ga.md")).toBe("RECIPE");
    expect(resolveKindFromPath("meetings/20260827.standup.ab12cd34.md")).toBe(
      "MEETING",
    );
    for (const folder of [
      "one-on-ones",
      "one-on-one",
      "1-1s",
      "1on1",
      "121s",
    ]) {
      expect(resolveKindFromPath(`${folder}/x.md`)).toBe("ONE_ON_ONE");
    }
  });

  it("tolerates leading slashes and nested paths", () => {
    expect(resolveKindFromPath("/journal/2026/05/29.md")).toBe("JOURNAL");
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
  it("reads underscore-bearing AI conversation kinds", () => {
    expect(parseFrontmatterKind("---\ntype: AI_CONVERSATION\n---\nbody")).toBe(
      "AI_CONVERSATION",
    );
  });

  it("also accepts a `kind` key", () => {
    expect(parseFrontmatterKind("---\nkind: Todo\n---\nbody")).toBe("TODO");
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
    expect(resolveKind({ path: "daily/x.md" })).toBe("JOURNAL");
    expect(resolveKind({ path: "scratch.md" })).toBe("NOTE");
  });
});

describe("resolveKind prefers backend kind", () => {
  it("uses an explicit backend kind verbatim, ignoring path", () => {
    expect(resolveKind({ path: "projects/x.md", kind: "QUOTE" })).toBe("QUOTE");
  });
  it("falls back to path inference only when kind is absent", () => {
    expect(resolveKind({ path: "journals/2026-05-31.md", kind: null })).toBe(
      "JOURNAL",
    );
  });
});

describe("assignable kinds", () => {
  it("excludes quotation while retaining it in the backend-compatible kind set", () => {
    const backendKind: Kind = "QUOTE";

    expect(KINDS).toContain(backendKind);
    expect(ASSIGNABLE_KINDS).not.toContain(backendKind);
    expect(ASSIGNABLE_KINDS).toContain("NOTE");
  });
});

describe("sortKindsByLabel", () => {
  it("orders kinds alphabetically by display label, not token", () => {
    expect(sortKindsByLabel(ASSIGNABLE_KINDS)).toEqual([
      "ONE_ON_ONE", // "1:1" — digits sort before letters
      "AI_CONVERSATION",
      "ARCHIVE",
      "BOOK",
      "CAPTURE",
      "CODE",
      "CYCLE",
      "JOURNAL",
      "MEETING",
      "NOTE",
      "PERSON",
      "PROJECT",
      "RECIPE",
      "TASK",
      "TODO",
    ]);
  });

  it("returns a new array and leaves the input order intact", () => {
    const input = [...ASSIGNABLE_KINDS];
    const sorted = sortKindsByLabel(input);
    expect(sorted).not.toBe(input);
    expect(input).toEqual([...ASSIGNABLE_KINDS]);
  });
});

describe("KIND_META", () => {
  it("includes AI conversations in the runtime kind list", () => {
    expect(KINDS).toContain("AI_CONVERSATION");
  });

  it("includes recipes in the runtime kind list", () => {
    expect(KINDS).toContain("RECIPE");
  });

  it("includes meetings and 1:1s in the runtime kind list", () => {
    expect(KINDS).toContain("MEETING");
    expect(KINDS).toContain("ONE_ON_ONE");
  });

  it("labels a one-on-one the way it is spoken", () => {
    expect(kindLabel("ONE_ON_ONE")).toBe("1:1");
    expect(kindLabel("MEETING")).toBe("MEETING");
  });

  it("uses the exact AI conversation label", () => {
    expect(kindLabel("AI_CONVERSATION")).toBe("AI CONVERSATION");
  });

  it("uses the exact recipe label", () => {
    expect(kindLabel("RECIPE")).toBe("RECIPE");
  });
  it("has a label and color var for every kind", () => {
    for (const k of KINDS) {
      expect(KIND_META[k].label.length).toBeGreaterThan(0);
      expect(kindColorVar(k)).toMatch(/^var\(--/);
      expect(kindLabel(k)).toBe(KIND_META[k].label);
    }
  });
});

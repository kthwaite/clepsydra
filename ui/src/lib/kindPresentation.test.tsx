import { describe, expect, it } from "vitest";
import { KINDS } from "#/lib/kind";
import { presentationFor } from "#/lib/kindPresentation";

describe("presentationFor", () => {
  it("uses the shared editor presentation for ordinary notes", () => {
    const presentation = presentationFor("NOTE");

    expect(presentation.bodyPresentation).toBe("editor");
    expect(presentation.metaExtras).toBeNull();
    expect(presentation.headerExtras).toBeNull();
  });

  it("selects the transcript presentation for AI conversations", () => {
    expect(presentationFor("AI_CONVERSATION").bodyPresentation).toBe(
      "ai-conversation",
    );
  });

  it("selects the recipe presentation for recipes", () => {
    expect(presentationFor("RECIPE").bodyPresentation).toBe("recipe");
  });

  it("retains Journal's title and metadata presentation", () => {
    const presentation = presentationFor("JOURNAL");

    expect(presentation.bodyPresentation).toBe("editor");
    expect(presentation.metaExtras).not.toBeNull();
    expect(presentation.metaExtrasLabel).toBe("Journal");
    // journalDayLabel formats via toLocaleDateString(undefined, ...), so the
    // exact string follows the runtime locale; assert structurally.
    const title = presentation.readOnlyTitle?.("journals/2026-08-09.md", "");
    expect(title).toMatch(/Sunday/);
    expect(title).toMatch(/August/);
    expect(title).toMatch(/\b9\b/);
    expect(title).toMatch(/2026/);
  });

  it("gives meetings the bespoke header block", () => {
    const presentation = presentationFor("MEETING");
    expect(presentation.bodyPresentation).toBe("editor");
    expect(presentation.metaExtras).toBeNull();
    expect(presentation.metaExtrasLabel).toBeUndefined();
    expect(presentation.headerExtras).not.toBeNull();
  });

  it("keeps Journal's day navigation in the rail", () => {
    for (const kind of ["JOURNAL", "AI_JOURNAL"] as const) {
      const presentation = presentationFor(kind);
      expect(presentation.headerExtras).toBeNull();
      expect(presentation.metaExtras).not.toBeNull();
    }
  });

  it("resolves every known kind without throwing", () => {
    for (const kind of KINDS) {
      expect(() => presentationFor(kind)).not.toThrow();
    }
  });
});

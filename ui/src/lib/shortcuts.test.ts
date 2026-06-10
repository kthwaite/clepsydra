import { describe, expect, it } from "vitest";
import {
  formatChord,
  GLOBAL_SHORTCUT_IDS,
  matchesChord,
  SHORTCUTS,
  shortcutsByGroup,
} from "#/lib/shortcuts";

type Mods = Partial<{
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}>;

function ev(key: string, mods: Mods = {}) {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}

describe("matchesChord", () => {
  it("matches mod chords with either metaKey or ctrlKey", () => {
    const chord = { key: "k", mod: true };
    expect(matchesChord(ev("k", { metaKey: true }), chord)).toBe(true);
    expect(matchesChord(ev("k", { ctrlKey: true }), chord)).toBe(true);
    expect(matchesChord(ev("k"), chord)).toBe(false);
  });

  it("rejects extra alt on a mod chord", () => {
    expect(
      matchesChord(ev("k", { metaKey: true, altKey: true }), {
        key: "k",
        mod: true,
      }),
    ).toBe(false);
  });

  it("matches letters case-insensitively and ignores shift on letters", () => {
    const chord = { key: "b", mod: true };
    expect(
      matchesChord(ev("B", { metaKey: true, shiftKey: true }), chord),
    ).toBe(true);
  });

  it("enforces shift on non-letter keys", () => {
    const chord = { key: "/", mod: true };
    expect(matchesChord(ev("/", { metaKey: true }), chord)).toBe(true);
    expect(
      matchesChord(ev("/", { metaKey: true, shiftKey: true }), chord),
    ).toBe(false);
  });

  it("ctrl chords require ctrl specifically, not meta", () => {
    const next = { key: "Tab", ctrl: true };
    const prev = { key: "Tab", ctrl: true, shift: true };
    expect(matchesChord(ev("Tab", { ctrlKey: true }), next)).toBe(true);
    expect(matchesChord(ev("Tab", { metaKey: true }), next)).toBe(false);
    // shifted variant matches prev, not next
    const shifted = ev("Tab", { ctrlKey: true, shiftKey: true });
    expect(matchesChord(shifted, next)).toBe(false);
    expect(matchesChord(shifted, prev)).toBe(true);
  });

  it("bare Tab matches only without modifiers", () => {
    const chord = { key: "Tab" };
    expect(matchesChord(ev("Tab"), chord)).toBe(true);
    expect(matchesChord(ev("Tab", { ctrlKey: true }), chord)).toBe(false);
    expect(matchesChord(ev("Tab", { shiftKey: true }), chord)).toBe(false);
  });

  it("alt chords require alt", () => {
    const chord = { key: "ArrowUp", alt: true };
    expect(matchesChord(ev("ArrowUp", { altKey: true }), chord)).toBe(true);
    expect(matchesChord(ev("ArrowUp"), chord)).toBe(false);
  });
});

describe("formatChord", () => {
  it("formats for Mac with glyph runs", () => {
    expect(formatChord({ key: "k", mod: true }, true)).toBe("⌘K");
    expect(formatChord({ key: "Tab", ctrl: true, shift: true }, true)).toBe(
      "⌃⇧Tab",
    );
    expect(formatChord({ key: "ArrowUp", alt: true }, true)).toBe("⌥↑");
    expect(formatChord({ key: "Enter", mod: true }, true)).toBe("⌘⏎");
  });

  it("formats for non-Mac with + separators", () => {
    expect(formatChord({ key: "k", mod: true }, false)).toBe("Ctrl+K");
    expect(formatChord({ key: "Tab", ctrl: true, shift: true }, false)).toBe(
      "Ctrl+Shift+Tab",
    );
    expect(formatChord({ key: "ArrowDown", alt: true }, false)).toBe("Alt+↓");
  });
});

describe("registry", () => {
  it("shortcutsByGroup covers every shortcut exactly once", () => {
    const listed = shortcutsByGroup().flatMap(([, defs]) =>
      defs.map((d) => d.id),
    );
    expect(listed.sort()).toEqual(Object.keys(SHORTCUTS).sort());
  });

  it("GLOBAL_SHORTCUT_IDS contains exactly the global-scope entries", () => {
    for (const id of GLOBAL_SHORTCUT_IDS) {
      expect(SHORTCUTS[id].scope).toBe("global");
    }
    expect(GLOBAL_SHORTCUT_IDS).toContain("palette.toggle");
    expect(GLOBAL_SHORTCUT_IDS).not.toContain("editor.mark.bold");
    expect(GLOBAL_SHORTCUT_IDS).not.toContain("folio.save");
  });

  it("GLOBAL_SHORTCUT_IDS is complete", () => {
    const allGlobalIds = (
      Object.keys(SHORTCUTS) as Array<keyof typeof SHORTCUTS>
    ).filter((id) => SHORTCUTS[id].scope === "global");
    expect([...GLOBAL_SHORTCUT_IDS].sort()).toEqual(allGlobalIds.sort());
  });

  it("groups are ordered Navigate, Workspace, Editor with stable entries", () => {
    const groups = shortcutsByGroup();
    expect(groups.map(([g]) => g)).toEqual(["Navigate", "Workspace", "Editor"]);
    expect(groups[0][1][0].id).toBe("palette.toggle");
  });
});

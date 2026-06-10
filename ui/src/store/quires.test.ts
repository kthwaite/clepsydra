import { describe, expect, it } from "vitest";
import type { TabDescriptor } from "#/store/workspace";
import {
  cycleTargetId,
  deriveQuireName,
  isTabHidden,
  nearestVisibleTabId,
  nextQuireColor,
  type Quire,
  QUIRE_COLORS,
  quireColorVar,
} from "./quires";

function tab(id: string, quireId?: string, pinned?: boolean): TabDescriptor {
  return { id, type: "page", path: `${id}.md`, label: id, quireId, pinned };
}

function quire(id: string, collapsed = false): Quire {
  return { id, name: id, color: "sepia", collapsed };
}

describe("quireColorVar", () => {
  it("maps a color token to its CSS custom property", () => {
    expect(quireColorVar("verdigris")).toBe("var(--quire-verdigris)");
  });
});

describe("nextQuireColor", () => {
  it("picks the first unused hue", () => {
    const quires: Record<string, Quire> = {
      a: { id: "a", name: "A", color: "sepia", collapsed: false },
      b: { id: "b", name: "B", color: "verdigris", collapsed: false },
    };
    expect(nextQuireColor(quires)).toBe("slate");
  });

  it("cycles once all six hues are used", () => {
    const quires: Record<string, Quire> = {};
    QUIRE_COLORS.forEach((color, i) => {
      quires[`q${i}`] = { id: `q${i}`, name: `Q${i}`, color, collapsed: false };
    });
    expect(nextQuireColor(quires)).toBe(QUIRE_COLORS[0]);
  });
});

describe("deriveQuireName", () => {
  it("uppercases the first word, capped at 12 chars", () => {
    expect(deriveQuireName("thesis chapter one")).toBe("THESIS");
    expect(deriveQuireName("antidisestablishment")).toBe("ANTIDISESTAB");
  });

  it("falls back to QUIRE for empty labels", () => {
    expect(deriveQuireName("   ")).toBe("QUIRE");
  });
});

describe("isTabHidden", () => {
  it("is true only for members of a collapsed quire", () => {
    const quires = { q1: quire("q1", true), q2: quire("q2", false) };
    expect(isTabHidden(tab("a", "q1"), quires)).toBe(true);
    expect(isTabHidden(tab("b", "q2"), quires)).toBe(false);
    expect(isTabHidden(tab("c"), quires)).toBe(false);
  });
});

describe("nearestVisibleTabId", () => {
  const quires = { q1: quire("q1", true) };
  const tabs = [tab("a"), tab("b", "q1"), tab("c", "q1"), tab("d")];

  it("scans right first, skipping hidden tabs", () => {
    expect(nearestVisibleTabId(tabs, quires, 1)).toBe("d");
  });

  it("falls back to scanning left", () => {
    const rightHidden = [tab("a"), tab("b", "q1"), tab("c", "q1")];
    expect(nearestVisibleTabId(rightHidden, quires, 1)).toBe("a");
  });

  it("returns null when nothing is visible", () => {
    const allHidden = [tab("b", "q1"), tab("c", "q1")];
    expect(nearestVisibleTabId(allHidden, quires, 0)).toBeNull();
  });
});

describe("cycleTargetId", () => {
  const quires = { q1: quire("q1", true) };
  const tabs = [tab("a"), tab("b", "q1"), tab("c", "q1"), tab("d")];

  it("cycles forward over visible tabs only, wrapping", () => {
    expect(cycleTargetId(tabs, quires, "a", false)).toBe("d");
    expect(cycleTargetId(tabs, quires, "d", false)).toBe("a");
  });

  it("cycles backward over visible tabs only, wrapping", () => {
    expect(cycleTargetId(tabs, quires, "a", true)).toBe("d");
  });

  it("returns null when fewer than two tabs are visible", () => {
    expect(cycleTargetId([tab("a"), tab("b", "q1")], quires, "a", false)).toBeNull();
  });
});

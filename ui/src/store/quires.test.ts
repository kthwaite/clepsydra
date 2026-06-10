import { describe, expect, it } from "vitest";
import type { TabDescriptor } from "#/store/workspace";
import {
  cycleTargetId,
  deriveQuireName,
  isTabHidden,
  nearestVisibleTabId,
  nextQuireColor,
  normalizeQuires,
  orderSheafTabs,
  QUIRE_COLORS,
  type Quire,
  quireColorVar,
  sheafSegments,
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
    expect(
      cycleTargetId([tab("a"), tab("b", "q1")], quires, "a", false),
    ).toBeNull();
  });
});

describe("normalizeQuires", () => {
  it("gathers a quire's members behind its first member", () => {
    const quires = { q1: quire("q1") };
    const tabs = [tab("a", "q1"), tab("x"), tab("b", "q1"), tab("y")];
    const out = normalizeQuires(tabs, quires);
    expect(out.tabs.map((t) => t.id)).toEqual(["a", "b", "x", "y"]);
  });

  it("leaves already-contiguous arrays untouched in order", () => {
    const quires = { q1: quire("q1") };
    const tabs = [tab("x"), tab("a", "q1"), tab("b", "q1"), tab("y")];
    const out = normalizeQuires(tabs, quires);
    expect(out.tabs.map((t) => t.id)).toEqual(["x", "a", "b", "y"]);
  });

  it("drops quires that have no members", () => {
    const quires = { q1: quire("q1"), ghost: quire("ghost") };
    const out = normalizeQuires([tab("a", "q1")], quires);
    expect(out.quires.q1).toBeDefined();
    expect(out.quires.ghost).toBeUndefined();
  });

  it("strips quireIds that reference nonexistent quires", () => {
    const out = normalizeQuires([tab("a", "deleted")], {});
    expect(out.tabs[0].quireId).toBeUndefined();
    expect(out.quires).toEqual({});
  });

  it("displaces non-member tabs to after the gathered run", () => {
    const quires = { q1: quire("q1") };
    const graph: TabDescriptor = { id: "g", type: "graph", label: "Graph" };
    const tabs = [tab("a", "q1"), graph, tab("b", "q1")];
    const out = normalizeQuires(tabs, quires);
    expect(out.tabs.map((t) => t.id)).toEqual(["a", "b", "g"]);
  });
});

describe("orderSheafTabs", () => {
  it("floats pinned-ungrouped tabs to the front, keeps segments in order", () => {
    const quires = { q1: quire("q1") };
    const tabs = [
      tab("a", "q1"),
      tab("b", "q1"),
      tab("x"),
      tab("p", undefined, true),
    ];
    expect(orderSheafTabs(tabs, quires).map((t) => t.id)).toEqual([
      "p",
      "a",
      "b",
      "x",
    ]);
  });

  it("sorts pinned members first within their quire, not globally", () => {
    const quires = { q1: quire("q1") };
    const tabs = [
      tab("x"),
      tab("a", "q1"),
      tab("b", "q1", true),
      tab("c", "q1"),
    ];
    expect(orderSheafTabs(tabs, quires).map((t) => t.id)).toEqual([
      "x",
      "b",
      "a",
      "c",
    ]);
  });
});

describe("sheafSegments", () => {
  it("groups ordered tabs into tab and quire segments", () => {
    const quires = { q1: quire("q1") };
    const ordered = [tab("x"), tab("a", "q1"), tab("b", "q1"), tab("y")];
    const segs = sheafSegments(ordered, quires);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toMatchObject({ kind: "tab", tab: { id: "x" } });
    expect(segs[1]).toMatchObject({ kind: "quire", quire: { id: "q1" } });
    expect(
      segs[1].kind === "quire" && segs[1].members.map((m) => m.id),
    ).toEqual(["a", "b"]);
    expect(segs[2]).toMatchObject({ kind: "tab", tab: { id: "y" } });
  });

  it("treats tabs with unknown quireIds as ungrouped", () => {
    const segs = sheafSegments([tab("a", "ghost")], {});
    expect(segs[0].kind).toBe("tab");
  });
});

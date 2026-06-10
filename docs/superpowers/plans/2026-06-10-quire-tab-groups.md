# Quire Tab Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chrome-style tab groups ("quires") in the SHEAF tab strip — named, colored, collapsible clusters of contiguous page tabs, managed via a new right-click context menu and ⌘K palette commands.

**Architecture:** The Zustand workspace store keeps its flat `tabs` array; membership is an optional `quireId` on each `TabDescriptor` plus a new `quires: Record<string, Quire>` map. Contiguity is an invariant re-established by a pure `normalizeQuires` step after every mutating action (same philosophy as Slate's `normalizeNode`). All pure logic (ordering, visibility, normalization, segmenting) lives in a new `ui/src/store/quires.ts` domain module so it is unit-testable without React.

**Tech Stack:** React 19, Zustand (persist middleware), Tailwind v4 tokens in `main.css`, Vitest + @testing-library/react, Biome. All commands run via Bun from `ui/`.

---

## Design decisions (locked, from 2026-06-10 grilling session)

1. **Model:** Chrome-style contiguous clusters. Not sessions, not auto-grouping, not split panes.
2. **Naming:** A group is a **quire** (codicology: a gathering of folios bound into a codex). `Quire` / `quireId` / `quires` in code, `QUIRE` in UI copy.
3. **Pin × quire:** Display order is hierarchical — pinned-ungrouped tabs first, then segments in array order; *within* a quire run, pinned members sort first. Pin keeps both meanings (close-protected + sorts-first-in-segment).
4. **Collapse:** Hidden = skipped. Invariant: **the active tab is never hidden.** Collapsing the active tab's quire activates the nearest visible tab. Ctrl-Tab cycling and close-neighbor activation skip hidden tabs. An *explicit* open of a hidden path (`openTab`) auto-expands the quire.
5. **Inheritance:** A new page tab spawned while the active tab is a quire member inherits that `quireId` and lands at the end of the quire run. "Replace" navigation mode keeps the slot's quire.
6. **Lifecycle:** No empty quires — closing the last member deletes the quire record. "Close quire" closes unpinned members only; pinned members (and therefore the quire) survive. Quires are only created from a tab.
7. **Assignment UX:** New hand-rolled right-click context menu on Sheaf tabs and quire labels (also houses PIN / CLOSE / CLOSE OTHERS), plus ⌘K palette commands. Drag-and-drop stays deferred per `docs/design-notes/defer-tabbar-rac-migration.md`.
8. **Visuals:** Six desaturated "ledger hue" tokens (`--quire-sepia`, `-verdigris`, `-slate`, `-madder`, `-ochre`, `-indigo`), auto-assigned in rotation, recolorable via menu. Membership renders as a 2px rule along the **top** edge of member tabs and the label cell; the orange active-tab underline keeps the bottom edge. Collapsed quire renders as its label cell plus member count (`THESIS ·3`).

**Deliberate behavior change:** `closeOtherTabs` currently closes pinned tabs too (`workspace.ts:151-156`). This plan changes it to spare pinned tabs, aligning with the decided pin semantic ("protected from every bulk close"). Flagged to the operator; see Task 8.

**Out of scope:** drag-and-drop reordering, keyboard shortcut for collapse, middle-click close, RAC migration, quire persistence beyond localStorage, Storybook stories.

**Edge-case rulings** (implement exactly as stated):
- Closing the last *visible* tab while others hide inside collapsed quires → `activeTabId: null` (FolioLauncher shows). Do not auto-expand.
- `nearestVisibleTabId` may select a graph tab — same as today's neighbor activation, which also ignores tab type.
- Adding the **active** tab to a collapsed quire expands that quire (invariant 4). Adding a non-active tab to a collapsed quire leaves it collapsed (the tab is "filed away").
- Ctrl-Tab cycles in **array order** over visible tabs (today it cycles array order over all tabs; display order already differs and that stays acceptable).
- The `§ SHEAF n` count keeps counting all page tabs, including hidden members.
- Graph tabs never get a `quireId` and never inherit one.

**Before you start:** branch off develop:

```bash
git checkout develop && git checkout -b feature/quire-tab-groups
```

---

## File structure

| File | Status | Responsibility |
|---|---|---|
| `ui/src/main.css` | Modify | Six quire hue custom properties, dark `:root` + `.paper` variants |
| `ui/src/store/quires.ts` | Create | Pure quire domain: types, colors, visibility, normalization, display ordering, segmenting |
| `ui/src/store/quires.test.ts` | Create | Unit tests for the domain module |
| `ui/src/store/workspace.ts` | Modify | `quires` state, persist v3 migration, quire actions, normalize-after-mutation, inheritance, visibility-aware activation |
| `ui/src/store/workspace.test.ts` | Modify | Tests for new store behavior |
| `ui/src/hooks/useGlobalShortcuts.tsx` | Modify | Ctrl-Tab (`tabs.next`/`tabs.prev`) cycles visible tabs only |
| `ui/src/components/codex/Sheaf.tsx` | Modify | Segment-based rendering: quire label cells, top-edge rules, collapsed chips, context-menu wiring |
| `ui/src/components/codex/__tests__/Sheaf.test.tsx` | Create | Component tests for quire rendering |
| `ui/src/components/codex/SheafContextMenu.tsx` | Create | Hand-rolled context menu (tab target + quire target) |
| `ui/src/components/codex/__tests__/SheafContextMenu.test.tsx` | Create | Component tests for menu actions |
| `ui/src/components/codex/CommandPalette.tsx` | Modify | `Quire:` palette commands |

Import-cycle note: `quires.ts` imports **only the type** `TabDescriptor` from `workspace.ts` (`import type`, erased at runtime); `workspace.ts` imports values from `quires.ts`. No runtime cycle. `verbatimModuleSyntax` is on — keep `import type` exact as written.

---

### Task 1: Quire ledger-hue tokens

**Files:**
- Modify: `ui/src/main.css` (the `:root` block at ~line 89 and the `.paper` block at ~line 122)

- [ ] **Step 1: Add dark-mode tokens**

In the `:root` block, directly after the line `--hot: #ff3b1f;` (main.css:102), insert:

```css
    /* Quire (tab-group) ledger hues — desaturated ink-stamp palette */
    --quire-sepia: #a98e63;
    --quire-verdigris: #5fa68c;
    --quire-slate: #7d93a8;
    --quire-madder: #b06a66;
    --quire-ochre: #c2a14a;
    --quire-indigo: #8a82b8;
```

- [ ] **Step 2: Add paper-mode overrides**

In the `.paper` block, directly after the line `--ink-faint: #9a978a;` (main.css:130), insert:

```css
    --quire-sepia: #7a6033;
    --quire-verdigris: #2f6f56;
    --quire-slate: #44607a;
    --quire-madder: #8c3f3a;
    --quire-ochre: #8a6a14;
    --quire-indigo: #4f4787;
```

- [ ] **Step 3: Verify**

Run: `grep -c -- "--quire-" ui/src/main.css`
Expected output: `12`

- [ ] **Step 4: Commit**

```bash
git add ui/src/main.css
git commit -m "feat(sheaf): add quire ledger-hue tokens"
```

---

### Task 2: Quire domain module — types, colors, visibility

**Files:**
- Create: `ui/src/store/quires.ts`
- Test: `ui/src/store/quires.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/store/quires.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/store/quires.test.ts)`
Expected: FAIL — cannot resolve `./quires`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/store/quires.ts`:

```ts
// Quires — Chrome-style tab groups in the SHEAF. In codicology a quire is a
// gathering of folios bound into a codex; here it is a named, coloured,
// collapsible cluster of contiguous page tabs.
//
// Invariants (re-established by normalizeQuires after every store mutation
// that can change membership or order — see workspace.ts):
//   1. Tabs sharing a quireId are contiguous in the tabs array.
//   2. A quire with no member tabs does not exist.
//   3. The active tab is never hidden (enforced by the store actions that
//      collapse quires or change activation).

import type { TabDescriptor } from "#/store/workspace";

export const QUIRE_COLORS = [
  "sepia",
  "verdigris",
  "slate",
  "madder",
  "ochre",
  "indigo",
] as const;

export type QuireColor = (typeof QUIRE_COLORS)[number];

export interface Quire {
  id: string;
  name: string;
  color: QuireColor;
  collapsed: boolean;
}

export function quireColorVar(color: QuireColor): string {
  return `var(--quire-${color})`;
}

/** First unused ledger hue; cycles once all six are taken. */
export function nextQuireColor(quires: Record<string, Quire>): QuireColor {
  const used = new Set(Object.values(quires).map((q) => q.color));
  return (
    QUIRE_COLORS.find((c) => !used.has(c)) ??
    QUIRE_COLORS[Object.keys(quires).length % QUIRE_COLORS.length]
  );
}

/** Default quire name derived from a tab label (palette flow). */
export function deriveQuireName(label: string): string {
  const word = label.trim().split(/\s+/)[0] ?? "";
  return (word || "QUIRE").toUpperCase().slice(0, 12);
}

/** A tab is hidden when it belongs to a collapsed quire. */
export function isTabHidden(
  tab: TabDescriptor,
  quires: Record<string, Quire>,
): boolean {
  return !!(tab.quireId && quires[tab.quireId]?.collapsed);
}

/** Nearest visible tab scanning right from `index`, then left; null if none. */
export function nearestVisibleTabId(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
  index: number,
): string | null {
  for (let i = Math.max(index, 0); i < tabs.length; i++) {
    if (!isTabHidden(tabs[i], quires)) return tabs[i].id;
  }
  for (let i = Math.min(index, tabs.length) - 1; i >= 0; i--) {
    if (!isTabHidden(tabs[i], quires)) return tabs[i].id;
  }
  return null;
}

/** Ctrl-Tab target: next/previous *visible* tab in array order, wrapping. */
export function cycleTargetId(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
  activeTabId: string | null,
  backwards: boolean,
): string | null {
  const visible = tabs.filter((t) => !isTabHidden(t, quires));
  if (visible.length < 2) return null;
  const idx = visible.findIndex((t) => t.id === activeTabId);
  const next = backwards
    ? (idx - 1 + visible.length) % visible.length
    : (idx + 1) % visible.length;
  return visible[next].id;
}
```

Note: `quireId` is added to `TabDescriptor` in Task 5. Until then `tab()` in the test file will not typecheck — that is fine for this task's *test run* (Vitest transpiles without typechecking), but run the tasks in order; the typecheck gate is Task 13.

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/store/quires.test.ts)`
Expected: PASS (all `describe` blocks above).

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/quires.ts ui/src/store/quires.test.ts
git commit -m "feat(store): quire domain module — colors, visibility, cycling"
```

---

### Task 3: `normalizeQuires`

**Files:**
- Modify: `ui/src/store/quires.ts`
- Test: `ui/src/store/quires.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/store/quires.test.ts` (add `normalizeQuires` to the existing import from `./quires`):

```ts
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

  it("keeps interleaved graph tabs in place outside quire runs", () => {
    const quires = { q1: quire("q1") };
    const graph: TabDescriptor = { id: "g", type: "graph", label: "Graph" };
    const tabs = [tab("a", "q1"), graph, tab("b", "q1")];
    const out = normalizeQuires(tabs, quires);
    expect(out.tabs.map((t) => t.id)).toEqual(["a", "b", "g"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/store/quires.test.ts)`
Expected: FAIL — `normalizeQuires` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `ui/src/store/quires.ts`:

```ts
/** Re-establish quire invariants: strip dangling quireIds, make members
 * contiguous (gathered behind each quire's first member), drop empty quires.
 * Pure; returns fresh arrays/maps and never mutates inputs. */
export function normalizeQuires(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
): { tabs: TabDescriptor[]; quires: Record<string, Quire> } {
  const cleaned = tabs.map((t) =>
    t.quireId && !quires[t.quireId] ? { ...t, quireId: undefined } : t,
  );

  const out: TabDescriptor[] = [];
  const seen = new Set<string>();
  for (const t of cleaned) {
    if (!t.quireId) {
      out.push(t);
    } else if (!seen.has(t.quireId)) {
      seen.add(t.quireId);
      out.push(...cleaned.filter((m) => m.quireId === t.quireId));
    }
  }

  const live: Record<string, Quire> = {};
  for (const id of seen) live[id] = quires[id];
  return { tabs: out, quires: live };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/store/quires.test.ts)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/quires.ts ui/src/store/quires.test.ts
git commit -m "feat(store): normalizeQuires — contiguity + dissolution invariants"
```

---

### Task 4: Display ordering and segmenting

**Files:**
- Modify: `ui/src/store/quires.ts`
- Test: `ui/src/store/quires.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/store/quires.test.ts` (add `orderSheafTabs`, `sheafSegments` to the import):

```ts
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
    const tabs = [tab("x"), tab("a", "q1"), tab("b", "q1", true), tab("c", "q1")];
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
    expect(segs[1].kind === "quire" && segs[1].members.map((m) => m.id)).toEqual(
      ["a", "b"],
    );
    expect(segs[2]).toMatchObject({ kind: "tab", tab: { id: "y" } });
  });

  it("treats tabs with unknown quireIds as ungrouped", () => {
    const segs = sheafSegments([tab("a", "ghost")], {});
    expect(segs[0].kind).toBe("tab");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/store/quires.test.ts)`
Expected: FAIL — `orderSheafTabs` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `ui/src/store/quires.ts`:

```ts
/** Display order for the SHEAF strip: pinned-ungrouped tabs first, then the
 * remaining segments in array order; within each quire run, pinned members
 * first. Assumes quire runs are already contiguous (post-normalize). */
export function orderSheafTabs(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
): TabDescriptor[] {
  void quires;
  const pinnedUngrouped = tabs.filter((t) => t.pinned && !t.quireId);
  const rest: TabDescriptor[] = [];
  let i = 0;
  while (i < tabs.length) {
    const t = tabs[i];
    if (t.pinned && !t.quireId) {
      i++;
    } else if (t.quireId) {
      const qid = t.quireId;
      const run: TabDescriptor[] = [];
      while (i < tabs.length && tabs[i].quireId === qid) {
        run.push(tabs[i]);
        i++;
      }
      rest.push(...run.filter((m) => m.pinned), ...run.filter((m) => !m.pinned));
    } else {
      rest.push(t);
      i++;
    }
  }
  return [...pinnedUngrouped, ...rest];
}

export type SheafSegment =
  | { kind: "tab"; tab: TabDescriptor }
  | { kind: "quire"; quire: Quire; members: TabDescriptor[] };

/** Fold display-ordered tabs into render segments for the SHEAF. Tabs whose
 * quireId has no live quire render as plain tabs. */
export function sheafSegments(
  orderedTabs: TabDescriptor[],
  quires: Record<string, Quire>,
): SheafSegment[] {
  const out: SheafSegment[] = [];
  for (const tab of orderedTabs) {
    const quire = tab.quireId ? quires[tab.quireId] : undefined;
    if (!quire) {
      out.push({ kind: "tab", tab });
      continue;
    }
    const last = out.at(-1);
    if (last?.kind === "quire" && last.quire.id === quire.id) {
      last.members.push(tab);
    } else {
      out.push({ kind: "quire", quire, members: [tab] });
    }
  }
  return out;
}
```

(`void quires;` keeps the signature uniform with the other helpers without tripping `noUnusedParameters`; the parameter stays because callers shouldn't care which helpers need the map.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/store/quires.test.ts)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/quires.ts ui/src/store/quires.test.ts
git commit -m "feat(store): sheaf display ordering and segment folding for quires"
```

---

### Task 5: Store state, `quireId` field, persist v3 migration

**Files:**
- Modify: `ui/src/store/workspace.ts`
- Test: `ui/src/store/workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/store/workspace.test.ts` (add `migrateWorkspace` to the import from `./workspace`):

```ts
describe("migrateWorkspace", () => {
  it("adds an empty quires map to v2 state", () => {
    const v2 = { tabs: [], activeTabId: null, openHistory: [] };
    const out = migrateWorkspace(v2, 2);
    expect(out.quires).toEqual({});
    expect(out.openHistory).toEqual([]);
  });

  it("adds both openHistory and quires to v1 state", () => {
    const out = migrateWorkspace({ tabs: [] }, 1);
    expect(out.openHistory).toEqual([]);
    expect(out.quires).toEqual({});
  });

  it("passes v3 state through untouched", () => {
    const v3 = { tabs: [], activeTabId: null, openHistory: [], quires: {} };
    expect(migrateWorkspace(v3, 3)).toEqual(v3);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/store/workspace.test.ts)`
Expected: FAIL — `migrateWorkspace` is not exported.

- [ ] **Step 3: Implement state + migration**

In `ui/src/store/workspace.ts`:

3a. Add the import at the top (after the existing zustand imports):

```ts
import { normalizeQuires, type Quire } from "#/store/quires";
```

3b. Add the field to `TabDescriptor` (after `lastActiveAt`):

```ts
  /** Membership in a quire (tab group). Members are kept contiguous. */
  quireId?: string;
```

3c. Add to `WorkspaceState`:

```ts
  quires: Record<string, Quire>;
```

3d. Add the normalize helper after the `tabKey` function:

```ts
/** Re-establish quire invariants after a mutation; merge any extra changes. */
function normalized(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
  extra: Partial<WorkspaceState> = {},
): Partial<WorkspaceState> {
  return { ...normalizeQuires(tabs, quires), ...extra };
}
```

3e. Add `quires: {},` to the initial state (after `openHistory: [],`).

3f. Replace the persist config's `version`/`migrate` with:

```ts
      version: 3,
      migrate: (persisted, version): Partial<WorkspaceState> =>
        migrateWorkspace(persisted, version),
```

and add the exported migration function at module scope (after `pushOpenHistory`):

```ts
/** Persist migrations: v1→v2 adds openHistory, v2→v3 adds quires. */
export function migrateWorkspace(
  persisted: unknown,
  version: number,
): Partial<WorkspaceState> {
  let s = (persisted ?? {}) as Partial<WorkspaceState>;
  if (version < 2 || !Array.isArray(s.openHistory)) {
    s = { ...s, openHistory: [] };
  }
  if (version < 3 || typeof s.quires !== "object" || s.quires === null) {
    s = { ...s, quires: {} };
  }
  return s;
}
```

(`normalized` is unused until Task 6 — TypeScript will not flag module-scope functions, but Biome may flag unused imports; `normalizeQuires` is used by `normalized`, so nothing dangles.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/store/workspace.test.ts)`
Expected: PASS (new + all pre-existing tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/workspace.ts ui/src/store/workspace.test.ts
git commit -m "feat(store): quires state field and persist v3 migration"
```

---

### Task 6: Quire membership and lifecycle actions

**Files:**
- Modify: `ui/src/store/workspace.ts`
- Test: `ui/src/store/workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/store/workspace.test.ts`:

```ts
function resetStore() {
  useWorkspaceStore.setState({
    tabs: [],
    activeTabId: null,
    navigationMode: "smart",
    openHistory: [],
    quires: {},
  });
}

function pageTab(id: string, quireId?: string, pinned?: boolean) {
  return { id, type: "page" as const, path: `${id}.md`, label: id, quireId, pinned };
}

describe("quire actions", () => {
  it("createQuire assigns membership and rotates colors", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1"), pageTab("t2")],
      activeTabId: "t1",
    });
    useWorkspaceStore.getState().createQuire("t1", "thesis");
    useWorkspaceStore.getState().createQuire("t2", "garden");

    const { tabs, quires } = useWorkspaceStore.getState();
    const list = Object.values(quires);
    expect(list.map((q) => q.name).sort()).toEqual(["garden", "thesis"]);
    expect(new Set(list.map((q) => q.color)).size).toBe(2);
    expect(tabs.find((t) => t.id === "t1")?.quireId).toBe(
      list.find((q) => q.name === "thesis")?.id,
    );
  });

  it("addTabToQuire gathers the tab into the quire run", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2"), pageTab("t3", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().addTabToQuire("t2", "q1");
    expect(useWorkspaceStore.getState().tabs.map((t) => t.id)).toEqual([
      "t1",
      "t3",
      "t2",
    ]);
  });

  it("addTabToQuire expands a collapsed quire when adding the active tab", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: true } },
    });
    useWorkspaceStore.getState().addTabToQuire("t2", "q1");
    expect(useWorkspaceStore.getState().quires.q1.collapsed).toBe(false);
  });

  it("removeTabFromQuire dissolves the quire when it empties", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().removeTabFromQuire("t1");
    const { tabs, quires } = useWorkspaceStore.getState();
    expect(tabs[0].quireId).toBeUndefined();
    expect(quires.q1).toBeUndefined();
  });

  it("toggleQuireCollapse moves activation off a hidden active tab", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1"), pageTab("t3")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().toggleQuireCollapse("q1");
    const state = useWorkspaceStore.getState();
    expect(state.quires.q1.collapsed).toBe(true);
    expect(state.activeTabId).toBe("t3");
  });

  it("toggleQuireCollapse nulls activation when nothing stays visible", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().toggleQuireCollapse("q1");
    expect(useWorkspaceStore.getState().activeTabId).toBeNull();
  });

  it("closeQuireTabs closes unpinned members; pinned + quire survive", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1", true), pageTab("t2", "q1"), pageTab("t3")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().closeQuireTabs("q1");
    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(state.quires.q1).toBeDefined();
    expect(state.activeTabId).toBe("t1");
  });

  it("closeQuireTabs dissolves a fully-unpinned quire", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().closeQuireTabs("q1");
    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(["t2"]);
    expect(state.quires.q1).toBeUndefined();
  });

  it("ungroupQuire strips membership and deletes the record", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().ungroupQuire("q1");
    const state = useWorkspaceStore.getState();
    expect(state.tabs.every((t) => t.quireId === undefined)).toBe(true);
    expect(state.quires.q1).toBeUndefined();
  });

  it("renameQuire and recolorQuire update the record", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().renameQuire("q1", "renamed");
    useWorkspaceStore.getState().recolorQuire("q1", "madder");
    const q = useWorkspaceStore.getState().quires.q1;
    expect(q.name).toBe("renamed");
    expect(q.color).toBe("madder");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/store/workspace.test.ts)`
Expected: FAIL — `createQuire is not a function`.

- [ ] **Step 3: Implement the actions**

In `ui/src/store/workspace.ts`:

3a. Extend the quires import:

```ts
import {
  nearestVisibleTabId,
  nextQuireColor,
  normalizeQuires,
  type Quire,
  type QuireColor,
} from "#/store/quires";
```

3b. Add to `WorkspaceActions`:

```ts
  createQuire: (tabId: string, name: string) => void;
  addTabToQuire: (tabId: string, quireId: string) => void;
  removeTabFromQuire: (tabId: string) => void;
  renameQuire: (quireId: string, name: string) => void;
  recolorQuire: (quireId: string, color: QuireColor) => void;
  toggleQuireCollapse: (quireId: string) => void;
  closeQuireTabs: (quireId: string) => void;
  ungroupQuire: (quireId: string) => void;
```

3c. Add the action implementations inside the store creator, after `setNavigationMode`:

```ts
      createQuire(tabId, name) {
        set((state) => {
          const tab = state.tabs.find((t) => t.id === tabId);
          if (!tab || tab.type !== "page") return state;
          const quire: Quire = {
            id: crypto.randomUUID(),
            name: name.trim() || "QUIRE",
            color: nextQuireColor(state.quires),
            collapsed: false,
          };
          return normalized(
            state.tabs.map((t) =>
              t.id === tabId ? { ...t, quireId: quire.id } : t,
            ),
            { ...state.quires, [quire.id]: quire },
          );
        });
      },

      addTabToQuire(tabId, quireId) {
        set((state) => {
          const quire = state.quires[quireId];
          const tab = state.tabs.find((t) => t.id === tabId);
          if (!quire || !tab || tab.type !== "page") return state;
          // Invariant: the active tab is never hidden — expand on demand.
          const expand = quire.collapsed && tabId === state.activeTabId;
          return normalized(
            state.tabs.map((t) => (t.id === tabId ? { ...t, quireId } : t)),
            expand
              ? { ...state.quires, [quireId]: { ...quire, collapsed: false } }
              : state.quires,
          );
        });
      },

      removeTabFromQuire(tabId) {
        set((state) =>
          normalized(
            state.tabs.map((t) =>
              t.id === tabId ? { ...t, quireId: undefined } : t,
            ),
            state.quires,
          ),
        );
      },

      renameQuire(quireId, name) {
        set((state) => {
          const quire = state.quires[quireId];
          if (!quire) return state;
          return {
            quires: {
              ...state.quires,
              [quireId]: { ...quire, name: name.trim() || quire.name },
            },
          };
        });
      },

      recolorQuire(quireId, color) {
        set((state) => {
          const quire = state.quires[quireId];
          if (!quire) return state;
          return { quires: { ...state.quires, [quireId]: { ...quire, color } } };
        });
      },

      toggleQuireCollapse(quireId) {
        set((state) => {
          const quire = state.quires[quireId];
          if (!quire) return state;
          const quires = {
            ...state.quires,
            [quireId]: { ...quire, collapsed: !quire.collapsed },
          };
          let activeTabId = state.activeTabId;
          if (!quire.collapsed) {
            // Collapsing: if the active tab just went hidden, re-home activation.
            const active = state.tabs.find((t) => t.id === state.activeTabId);
            if (active?.quireId === quireId) {
              const idx = state.tabs.findIndex((t) => t.id === active.id);
              activeTabId = nearestVisibleTabId(state.tabs, quires, idx);
            }
          }
          return { quires, activeTabId };
        });
      },

      closeQuireTabs(quireId) {
        set((state) => {
          const firstIdx = state.tabs.findIndex((t) => t.quireId === quireId);
          const nextTabs = state.tabs.filter(
            (t) => t.quireId !== quireId || t.pinned,
          );
          let activeTabId = state.activeTabId;
          if (activeTabId && !nextTabs.some((t) => t.id === activeTabId)) {
            const at = Math.min(
              Math.max(firstIdx, 0),
              Math.max(nextTabs.length - 1, 0),
            );
            activeTabId = nearestVisibleTabId(nextTabs, state.quires, at);
          }
          return normalized(nextTabs, state.quires, { activeTabId });
        });
      },

      ungroupQuire(quireId) {
        set((state) => {
          const { [quireId]: _, ...rest } = state.quires;
          return normalized(
            state.tabs.map((t) =>
              t.quireId === quireId ? { ...t, quireId: undefined } : t,
            ),
            rest,
          );
        });
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/store/workspace.test.ts)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/workspace.ts ui/src/store/workspace.test.ts
git commit -m "feat(store): quire membership and lifecycle actions"
```

---

### Task 7: `openTab` — inheritance, auto-expand, replace keeps quire

**Files:**
- Modify: `ui/src/store/workspace.ts` (the `openTab` and `addTab` actions)
- Test: `ui/src/store/workspace.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/store/workspace.test.ts` (inside a new describe; reuses `resetStore`/`pageTab` from Task 6):

```ts
describe("openTab quire integration", () => {
  it("a new tab inherits the active tab's quire and lands at the end of the run", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1"), pageTab("t3")],
      activeTabId: "t1",
      navigationMode: "smart",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().openTab("page", "new.md", "New");
    const { tabs } = useWorkspaceStore.getState();
    const created = tabs.find((t) => t.path === "new.md");
    expect(created?.quireId).toBe("q1");
    expect(tabs.map((t) => t.path)).toEqual([
      "t1.md",
      "t2.md",
      "new.md",
      "t3.md",
    ]);
  });

  it("does not inherit when the active tab is ungrouped", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1")],
      activeTabId: "t1",
      navigationMode: "smart",
    });
    useWorkspaceStore.getState().openTab("page", "new.md", "New");
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.path === "new.md")
        ?.quireId,
    ).toBeUndefined();
  });

  it("replace mode keeps the slot's quire membership", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1")],
      activeTabId: "t1",
      navigationMode: "replace",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().openTab("page", "other.md", "Other");
    const t1 = useWorkspaceStore.getState().tabs.find((t) => t.id === "t1");
    expect(t1?.path).toBe("other.md");
    expect(t1?.quireId).toBe("q1");
  });

  it("focusing an existing tab hidden in a collapsed quire auto-expands it", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      navigationMode: "smart",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: true } },
    });
    useWorkspaceStore.getState().openTab("page", "t1.md");
    const state = useWorkspaceStore.getState();
    expect(state.activeTabId).toBe("t1");
    expect(state.quires.q1.collapsed).toBe(false);
  });

  it("graph tabs never inherit a quire", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1")],
      activeTabId: "t1",
      navigationMode: "smart",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().openTab("graph");
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.type === "graph")
        ?.quireId,
    ).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/store/workspace.test.ts)`
Expected: FAIL — inheritance and auto-expand assertions fail (no `quireId` set; quire stays collapsed).

- [ ] **Step 3: Rewrite `openTab` and `addTab`**

Replace the entire `openTab` action in `ui/src/store/workspace.ts` with:

```ts
      openTab(type, path, label) {
        const state = get();
        const key = tabKey(type, path);

        // Check for existing tab with same content
        const existing = state.tabs.find((t) => tabKey(t.type, t.path) === key);

        if (existing) {
          // Always focus existing tab regardless of mode; an explicit open of
          // a hidden tab auto-expands its quire (active is never hidden).
          const quire = existing.quireId
            ? state.quires[existing.quireId]
            : undefined;
          set({
            activeTabId: existing.id,
            tabs: state.tabs.map((t) =>
              t.id === existing.id ? { ...t, lastActiveAt: Date.now() } : t,
            ),
            quires: quire?.collapsed
              ? { ...state.quires, [quire.id]: { ...quire, collapsed: false } }
              : state.quires,
            openHistory:
              existing.type === "page" && existing.path
                ? pushOpenHistory(state.openHistory, existing.path, Date.now())
                : state.openHistory,
          });
          return;
        }

        // New page tabs inherit the active page tab's quire (self-assembling
        // research context); graph tabs never join quires.
        const activeTab = state.tabs.find((t) => t.id === state.activeTabId);
        const newTab: TabDescriptor = {
          id: crypto.randomUUID(),
          type,
          path: type === "page" ? path : undefined,
          label: label ?? path ?? "Graph",
          lastActiveAt: Date.now(),
          quireId:
            type === "page" && activeTab?.type === "page"
              ? activeTab.quireId
              : undefined,
        };

        const nextHistory =
          type === "page" && path
            ? pushOpenHistory(state.openHistory, path, Date.now())
            : state.openHistory;

        if (state.navigationMode === "replace" && state.activeTabId) {
          // Replace the active tab's content; the slot keeps its quire.
          set(
            normalized(
              state.tabs.map((t) =>
                t.id === state.activeTabId
                  ? { ...newTab, id: t.id, quireId: t.quireId }
                  : t,
              ),
              state.quires,
              { openHistory: nextHistory },
            ),
          );
        } else {
          // "new" or "smart" — append; normalize gathers it to its quire run.
          set(
            normalized([...state.tabs, newTab], state.quires, {
              activeTabId: newTab.id,
              openHistory: nextHistory,
            }),
          );
        }
      },
```

Replace `addTab` with:

```ts
      addTab(tab) {
        set((state) =>
          normalized([...state.tabs, tab], state.quires, {
            activeTabId: tab.id,
          }),
        );
      },
```

And replace `moveTab` with (future-proofing: any reorder re-normalizes):

```ts
      moveTab(fromIndex, toIndex) {
        set((state) => {
          const tabs = [...state.tabs];
          const [moved] = tabs.splice(fromIndex, 1);
          tabs.splice(toIndex, 0, moved);
          return normalized(tabs, state.quires);
        });
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/store/workspace.test.ts)`
Expected: PASS — new tests and all pre-existing `openTab`/`updateTabPath` tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/workspace.ts ui/src/store/workspace.test.ts
git commit -m "feat(store): openTab quire inheritance and collapsed auto-expand"
```

---

### Task 8: Visibility-aware closing (`closeTab`, `closeOtherTabs`)

**Files:**
- Modify: `ui/src/store/workspace.ts`
- Test: `ui/src/store/workspace.test.ts`

> **Behavior change:** `closeOtherTabs` now spares pinned tabs. Previously it closed everything except the kept tab. This aligns with pin = "protected from every bulk close" (same rule as Close Quire). The operator approved the pin semantic; this specific extension was flagged in the design summary.

- [ ] **Step 1: Write the failing tests**

Append to `ui/src/store/workspace.test.ts`:

```ts
describe("visibility-aware closing", () => {
  it("closeTab skips hidden neighbors when re-homing activation", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1"), pageTab("t2", "q1"), pageTab("t3", "q1"), pageTab("t4")],
      activeTabId: "t1",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: true } },
    });
    useWorkspaceStore.getState().closeTab("t1");
    expect(useWorkspaceStore.getState().activeTabId).toBe("t4");
  });

  it("closeTab dissolves a quire when its last member closes", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2")],
      activeTabId: "t2",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().closeTab("t1");
    expect(useWorkspaceStore.getState().quires.q1).toBeUndefined();
  });

  it("closeOtherTabs spares pinned tabs and dead quires dissolve", () => {
    resetStore();
    useWorkspaceStore.setState({
      tabs: [pageTab("t1", "q1"), pageTab("t2", "q1", true), pageTab("t3")],
      activeTabId: "t3",
      quires: { q1: { id: "q1", name: "Q", color: "sepia", collapsed: false } },
    });
    useWorkspaceStore.getState().closeOtherTabs("t3");
    const state = useWorkspaceStore.getState();
    expect(state.tabs.map((t) => t.id)).toEqual(["t2", "t3"]);
    expect(state.quires.q1).toBeDefined(); // pinned member keeps it alive
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/store/workspace.test.ts)`
Expected: FAIL — `closeTab` activates `t2` (hidden); `closeOtherTabs` closes the pinned tab.

- [ ] **Step 3: Rewrite the two actions**

Replace `closeTab` in `ui/src/store/workspace.ts` with:

```ts
      closeTab(tabId) {
        const state = get();
        const idx = state.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return;

        const nextTabs = state.tabs.filter((t) => t.id !== tabId);
        let nextActive = state.activeTabId;

        if (state.activeTabId === tabId) {
          nextActive =
            nextTabs.length === 0
              ? null
              : nearestVisibleTabId(
                  nextTabs,
                  state.quires,
                  Math.min(idx, nextTabs.length - 1),
                );
        }

        set(normalized(nextTabs, state.quires, { activeTabId: nextActive }));
      },
```

Replace `closeOtherTabs` with:

```ts
      closeOtherTabs(tabId) {
        set((state) =>
          normalized(
            state.tabs.filter((t) => t.id === tabId || t.pinned),
            state.quires,
            { activeTabId: tabId },
          ),
        );
      },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/store/workspace.test.ts)`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/store/workspace.ts ui/src/store/workspace.test.ts
git commit -m "feat(store): visibility-aware close; closeOtherTabs spares pinned"
```

---

### Task 9: Ctrl-Tab cycles visible tabs only

**Files:**
- Modify: `ui/src/hooks/useGlobalShortcuts.tsx:24-29`

> Tab shortcuts now live in the central shortcut dispatcher (`useGlobalShortcuts`), not `routes/workspace.tsx` — a shortcut-registry refactor landed on develop 2026-06-10. The `tabs.next`/`tabs.prev` bindings call a module-scope `cycleTab(dir)` helper; that helper is the only thing to change. The cycling logic was extracted and tested as `cycleTargetId` in Task 2; this task is pure wiring.

- [ ] **Step 1: Rewire the helper**

In `ui/src/hooks/useGlobalShortcuts.tsx`, add the import:

```ts
import { cycleTargetId } from "#/store/quires";
```

and replace the existing `cycleTab` function:

```ts
function cycleTab(dir: 1 | -1) {
  const { tabs, activeTabId, activateTab } = useWorkspaceStore.getState();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  activateTab(tabs[(idx + dir + tabs.length) % tabs.length].id);
}
```

with:

```ts
function cycleTab(dir: 1 | -1) {
  const { tabs, quires, activeTabId, activateTab } =
    useWorkspaceStore.getState();
  const target = cycleTargetId(tabs, quires, activeTabId, dir === -1);
  if (target) activateTab(target);
}
```

The `tabs.next`/`tabs.prev` bindings and the rest of the dispatcher stay untouched. The existing `ui/src/hooks/useGlobalShortcuts.test.tsx` must keep passing — its scenarios have no quires, so every tab is visible and behavior is unchanged; if its `setState` calls predate the `quires` field, the store's initial `quires: {}` covers them.

- [ ] **Step 2: Verify**

Run: `(cd ui && bun run typecheck)`
Expected: clean exit (0).

Run: `(cd ui && bun run test)`
Expected: PASS (no regressions).

- [ ] **Step 3: Commit**

```bash
git add ui/src/routes/workspace.tsx
git commit -m "feat(workspace): ctrl-tab skips tabs hidden in collapsed quires"
```

---

### Task 10: Sheaf quire rendering

**Files:**
- Modify: `ui/src/components/codex/Sheaf.tsx` (full rewrite below)
- Test: `ui/src/components/codex/__tests__/Sheaf.test.tsx` (create)

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/codex/__tests__/Sheaf.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "#/store/workspace";
import { Sheaf } from "../Sheaf";

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
}));
vi.mock("#/api/index", () => ({
  useStats: () => ({ data: undefined }),
}));
vi.mock("#/components/codex/TabPreviewCard", () => ({
  TabPreviewCard: () => null,
}));

function seed(collapsed: boolean) {
  useWorkspaceStore.setState({
    tabs: [
      { id: "t1", type: "page", path: "a.md", label: "Alpha", quireId: "q1" },
      { id: "t2", type: "page", path: "b.md", label: "Beta", quireId: "q1" },
      { id: "t3", type: "page", path: "c.md", label: "Gamma" },
    ],
    activeTabId: "t3",
    quires: { q1: { id: "q1", name: "thesis", color: "sepia", collapsed } },
    openHistory: [],
  });
}

describe("Sheaf quire rendering", () => {
  it("renders the quire label cell before its member tabs", () => {
    seed(false);
    render(<Sheaf activeTabId="t3" />);
    expect(
      screen.getByRole("button", { name: /quire thesis/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Alpha")).toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("hides member tabs and shows the count when collapsed", () => {
    seed(true);
    render(<Sheaf activeTabId="t3" />);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("·2")).toBeInTheDocument();
  });

  it("counts hidden members in the SHEAF total", () => {
    seed(true);
    render(<Sheaf activeTabId="t3" />);
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("clicking the label toggles collapse in the store", async () => {
    seed(false);
    const user = userEvent.setup();
    render(<Sheaf activeTabId="t3" />);
    await user.click(screen.getByRole("button", { name: /quire thesis/i }));
    expect(useWorkspaceStore.getState().quires.q1.collapsed).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/components/codex/__tests__/Sheaf.test.tsx)`
Expected: FAIL — no quire label rendered.

- [ ] **Step 3: Rewrite Sheaf.tsx**

Replace the entire contents of `ui/src/components/codex/Sheaf.tsx` with:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { Pin, X } from "lucide-react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
import { useStats } from "#/api/index";
import { TabPreviewCard } from "#/components/codex/TabPreviewCard";
import { shouldPreviewTab } from "#/components/codex/tab-preview";
import { cn } from "#/lib/cn";
import { kindColorVar, resolveKindFromPath } from "#/lib/kind";
import {
  orderSheafTabs,
  type Quire,
  quireColorVar,
  sheafSegments,
} from "#/store/quires";
import { type TabDescriptor, useWorkspaceStore } from "#/store/workspace";

type SheafProps = {
  activeTabId: string | null;
};

// Cold-open delay; once a card is showing, scrubbing to another tab is instant.
const HOVER_DELAY = 220;

export function Sheaf({ activeTabId }: SheafProps) {
  const navigate = useNavigate();
  const tabs = useWorkspaceStore((s) => s.tabs);
  const quires = useWorkspaceStore((s) => s.quires);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const toggleQuireCollapse = useWorkspaceStore((s) => s.toggleQuireCollapse);
  const { data: stats } = useStats();

  const pageTabs = orderSheafTabs(
    tabs.filter((t) => t.type === "page"),
    quires,
  );
  const segments = sheafSegments(pageTabs, quires);

  const [hovered, setHovered] = useState<{ id: string; rect: DOMRect } | null>(
    null,
  );
  const openTimer = useRef<number | null>(null);

  const clearOpenTimer = () => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  };

  useEffect(() => clearOpenTimer, []);

  const onTabEnter = (
    id: string,
    path: string | undefined,
    el: HTMLElement,
  ) => {
    if (!shouldPreviewTab(path, id, activeTabId)) return;
    clearOpenTimer();
    const show = () => setHovered({ id, rect: el.getBoundingClientRect() });
    // Instant-scrub: if a card is already open, switch with no re-delay.
    if (hovered) {
      show();
    } else {
      openTimer.current = window.setTimeout(show, HOVER_DELAY);
    }
  };

  const onTabLeave = () => {
    clearOpenTimer();
    setHovered(null);
  };

  const onActivate = (id: string) => {
    clearOpenTimer();
    setHovered(null);
    activateTab(id);
    navigate({ to: "/workspace" });
  };

  const hoveredPath = hovered
    ? (pageTabs.find((t) => t.id === hovered.id)?.path ?? null)
    : null;

  return (
    <div className="cl-mono cl-noscroll flex flex-shrink-0 items-stretch overflow-x-auto border-b border-rule bg-paper-2">
      <span className="flex flex-shrink-0 items-center gap-1.5 whitespace-nowrap border-r border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        § SHEAF
        <span className="text-ink-2">{pageTabs.length}</span>
      </span>

      {segments.map((seg) =>
        seg.kind === "tab" ? (
          <FolioTab
            key={seg.tab.id}
            tab={seg.tab}
            active={seg.tab.id === activeTabId}
            onActivate={onActivate}
            onEnter={onTabEnter}
            onLeave={onTabLeave}
          />
        ) : (
          <Fragment key={seg.quire.id}>
            <button
              type="button"
              onClick={() => toggleQuireCollapse(seg.quire.id)}
              aria-expanded={!seg.quire.collapsed}
              aria-label={`quire ${seg.quire.name}, ${seg.members.length} folios`}
              className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap border-r border-rule-soft px-2.5 py-1 text-[9px] uppercase tracking-[0.18em]"
              style={{
                color: quireColorVar(seg.quire.color),
                boxShadow: `inset 0 2px 0 0 ${quireColorVar(seg.quire.color)}`,
              }}
            >
              {seg.quire.name}
              {seg.quire.collapsed && (
                <span className="text-ink-mute">·{seg.members.length}</span>
              )}
            </button>
            {!seg.quire.collapsed &&
              seg.members.map((t) => (
                <FolioTab
                  key={t.id}
                  tab={t}
                  quire={seg.quire}
                  active={t.id === activeTabId}
                  onActivate={onActivate}
                  onEnter={onTabEnter}
                  onLeave={onTabLeave}
                />
              ))}
          </Fragment>
        ),
      )}

      {hoveredPath && hovered && (
        <TabPreviewCard path={hoveredPath} rect={hovered.rect} />
      )}

      <span className="flex-1" />
      <span className="flex flex-shrink-0 items-center gap-2 border-l border-rule-soft px-3 py-1 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        <span className="text-ink-2">{stats?.pages ?? 0}</span> indexed
        <span className="border-l border-rule-soft pl-2">⌘N intake</span>
      </span>
    </div>
  );
}

type FolioTabProps = {
  tab: TabDescriptor;
  quire?: Quire;
  active: boolean;
  onActivate: (id: string) => void;
  onEnter: (id: string, path: string | undefined, el: HTMLElement) => void;
  onLeave: () => void;
};

function FolioTab({
  tab: t,
  quire,
  active,
  onActivate,
  onEnter,
  onLeave,
}: FolioTabProps) {
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const togglePin = useWorkspaceStore((s) => s.togglePin);

  const kind = resolveKindFromPath(t.path ?? "");
  const onClose = (e: ReactMouseEvent) => {
    e.stopPropagation();
    closeTab(t.id);
  };
  const onPin = (e: ReactMouseEvent) => {
    e.stopPropagation();
    togglePin(t.id);
  };

  // Quire membership rules the top edge; the active accent keeps the bottom.
  const rules = [
    quire ? `inset 0 2px 0 0 ${quireColorVar(quire.color)}` : null,
    active ? "inset 0 -2px 0 0 var(--accent)" : null,
  ].filter(Boolean);

  return (
    <button
      type="button"
      onClick={() => onActivate(t.id)}
      onMouseEnter={(e) => onEnter(t.id, t.path, e.currentTarget)}
      onMouseLeave={onLeave}
      title={t.path ? undefined : t.label}
      aria-label={t.label || t.path || "untitled folio"}
      className={cn(
        "group flex max-w-[240px] flex-shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap border-r border-rule-soft py-1 pl-3 pr-2",
        active ? "bg-paper text-ink" : "text-ink-mute hover:text-ink",
      )}
      style={rules.length ? { boxShadow: rules.join(", ") } : undefined}
    >
      <span
        className="inline-block h-[6px] w-[6px] flex-shrink-0"
        style={{ background: kindColorVar(kind) }}
        aria-hidden
      />
      <span className="max-w-[160px] overflow-hidden text-ellipsis text-[12px]">
        {t.label || t.path || "(untitled)"}
      </span>
      <span
        onClick={onPin}
        onKeyDown={(e) => {
          if (e.key === "Enter") onPin(e as unknown as ReactMouseEvent);
        }}
        role="button"
        tabIndex={0}
        aria-label={t.pinned ? "unpin folio" : "pin folio"}
        className={cn(
          "flex-shrink-0 cursor-pointer px-[2px] leading-none transition-opacity",
          t.pinned
            ? "text-warn opacity-100"
            : "text-ink-mute opacity-0 group-hover:opacity-60 hover:!opacity-100",
        )}
      >
        <Pin size={11} fill={t.pinned ? "currentColor" : "none"} />
      </span>
      {!t.pinned && (
        <span
          onClick={onClose}
          onKeyDown={(e) => {
            if (e.key === "Enter") onClose(e as unknown as ReactMouseEvent);
          }}
          role="button"
          tabIndex={0}
          aria-label="close folio"
          className="flex-shrink-0 cursor-pointer px-[2px] leading-none text-ink-mute opacity-0 transition-opacity group-hover:opacity-60 hover:!opacity-100"
        >
          <X size={11} />
        </span>
      )}
    </button>
  );
}
```

What changed vs. the old file: the local `ordered()` pin sort is gone (replaced by `orderSheafTabs` + `sheafSegments`); the tab `<button>` moved into a `FolioTab` component that reads `closeTab`/`togglePin` from the store itself; the active-tab underline moved from a Tailwind shadow class to the combined inline `boxShadow` so it can stack with the quire top rule.

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/components/codex/__tests__/Sheaf.test.tsx)`
Expected: PASS (4 tests).

Run: `(cd ui && bun run typecheck)`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/Sheaf.tsx ui/src/components/codex/__tests__/Sheaf.test.tsx
git commit -m "feat(sheaf): render quires — label cells, top-edge rules, collapsed chips"
```

---

### Task 11: SheafContextMenu

**Files:**
- Create: `ui/src/components/codex/SheafContextMenu.tsx`
- Modify: `ui/src/components/codex/Sheaf.tsx` (wiring)
- Test: `ui/src/components/codex/__tests__/SheafContextMenu.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/codex/__tests__/SheafContextMenu.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "#/store/workspace";
import { SheafContextMenu } from "../SheafContextMenu";

function seed() {
  useWorkspaceStore.setState({
    tabs: [
      { id: "t1", type: "page", path: "a.md", label: "A" },
      { id: "t2", type: "page", path: "b.md", label: "B", quireId: "q1" },
    ],
    activeTabId: "t1",
    quires: { q1: { id: "q1", name: "thesis", color: "sepia", collapsed: false } },
    openHistory: [],
  });
}

describe("SheafContextMenu — tab target", () => {
  it("creates a quire via the NEW QUIRE flow", async () => {
    seed();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SheafContextMenu
        target={{ kind: "tab", tabId: "t1", x: 10, y: 10 }}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "NEW QUIRE…" }));
    await user.keyboard("drafts{Enter}");

    const { tabs, quires } = useWorkspaceStore.getState();
    const created = Object.values(quires).find((q) => q.name === "drafts");
    expect(created).toBeDefined();
    expect(tabs.find((t) => t.id === "t1")?.quireId).toBe(created?.id);
    expect(onClose).toHaveBeenCalled();
  });

  it("adds the tab to an existing quire", async () => {
    seed();
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SheafContextMenu
        target={{ kind: "tab", tabId: "t1", x: 10, y: 10 }}
        onClose={onClose}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: /add to thesis/i }));
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.id === "t1")?.quireId,
    ).toBe("q1");
  });

  it("removes a member from its quire", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "tab", tabId: "t2", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(
      screen.getByRole("menuitem", { name: "REMOVE FROM QUIRE" }),
    );
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.id === "t2")?.quireId,
    ).toBeUndefined();
  });
});

describe("SheafContextMenu — quire target", () => {
  it("renames via the RENAME flow", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "quire", quireId: "q1", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "RENAME…" }));
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("opus{Enter}");
    expect(useWorkspaceStore.getState().quires.q1.name).toBe("opus");
  });

  it("ungroups the quire", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "quire", quireId: "q1", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "UNGROUP" }));
    const state = useWorkspaceStore.getState();
    expect(state.quires.q1).toBeUndefined();
    expect(state.tabs.find((t) => t.id === "t2")?.quireId).toBeUndefined();
  });

  it("closes the quire's unpinned members", async () => {
    seed();
    const user = userEvent.setup();
    render(
      <SheafContextMenu
        target={{ kind: "quire", quireId: "q1", x: 10, y: 10 }}
        onClose={() => {}}
      />,
    );
    await user.click(screen.getByRole("menuitem", { name: "CLOSE QUIRE" }));
    expect(
      useWorkspaceStore.getState().tabs.map((t) => t.id),
    ).toEqual(["t1"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `(cd ui && bun run test src/components/codex/__tests__/SheafContextMenu.test.tsx)`
Expected: FAIL — cannot resolve `../SheafContextMenu`.

- [ ] **Step 3: Implement the menu**

Create `ui/src/components/codex/SheafContextMenu.tsx`:

```tsx
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "#/lib/cn";
import { QUIRE_COLORS, quireColorVar } from "#/store/quires";
import { useWorkspaceStore } from "#/store/workspace";

export type MenuTarget =
  | { kind: "tab"; tabId: string; x: number; y: number }
  | { kind: "quire"; quireId: string; x: number; y: number };

type SheafContextMenuProps = {
  target: MenuTarget;
  onClose: () => void;
};

const MENU_WIDTH = 220;

/** Hand-rolled context menu for SHEAF tabs and quire labels. RAC menus were
 * deferred for the tab strip (docs/design-notes/defer-tabbar-rac-migration.md);
 * this follows the CommandPalette's overlay + panel idiom instead. */
export function SheafContextMenu({ target, onClose }: SheafContextMenuProps) {
  const tabs = useWorkspaceStore((s) => s.tabs);
  const quires = useWorkspaceStore((s) => s.quires);
  // null = root menu; a string = a name being drafted (new quire / rename).
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const store = () => useWorkspaceStore.getState();
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const left = Math.max(
    4,
    Math.min(target.x, window.innerWidth - MENU_WIDTH - 8),
  );
  const top = Math.max(4, Math.min(target.y, window.innerHeight - 280));

  let content: React.ReactNode = null;

  if (target.kind === "tab") {
    const tab = tabs.find((t) => t.id === target.tabId);
    if (!tab) return null;
    content = (
      <>
        <Row
          label={tab.pinned ? "UNPIN" : "PIN"}
          onPick={act(() => store().togglePin(tab.id))}
        />
        {!tab.pinned && (
          <Row label="CLOSE" onPick={act(() => store().closeTab(tab.id))} />
        )}
        <Row
          label="CLOSE OTHERS"
          onPick={act(() => store().closeOtherTabs(tab.id))}
        />
        <Divider />
        {draft === null ? (
          <Row label="NEW QUIRE…" onPick={() => setDraft("")} />
        ) : (
          <NameInput
            value={draft}
            onChange={setDraft}
            onCommit={(name) => {
              store().createQuire(tab.id, name);
              onClose();
            }}
            onCancel={onClose}
          />
        )}
        {Object.values(quires)
          .filter((q) => q.id !== tab.quireId)
          .map((q) => (
            <Row
              key={q.id}
              label={`ADD TO ${q.name}`}
              swatch={quireColorVar(q.color)}
              onPick={act(() => store().addTabToQuire(tab.id, q.id))}
            />
          ))}
        {tab.quireId && (
          <Row
            label="REMOVE FROM QUIRE"
            onPick={act(() => store().removeTabFromQuire(tab.id))}
          />
        )}
      </>
    );
  } else {
    const quire = quires[target.quireId];
    if (!quire) return null;
    content = (
      <>
        {draft === null ? (
          <Row label="RENAME…" onPick={() => setDraft(quire.name)} />
        ) : (
          <NameInput
            value={draft}
            onChange={setDraft}
            onCommit={(name) => {
              store().renameQuire(quire.id, name);
              onClose();
            }}
            onCancel={onClose}
          />
        )}
        <div className="flex items-center gap-2 px-3 py-[5px]">
          {QUIRE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`recolor ${c}`}
              onClick={act(() => store().recolorQuire(quire.id, c))}
              className={cn(
                "h-[10px] w-[10px] cursor-pointer",
                quire.color === c && "outline outline-1 outline-ink",
              )}
              style={{ background: quireColorVar(c) }}
            />
          ))}
        </div>
        <Row
          label={quire.collapsed ? "EXPAND" : "COLLAPSE"}
          onPick={act(() => store().toggleQuireCollapse(quire.id))}
        />
        <Divider />
        <Row
          label="UNGROUP"
          onPick={act(() => store().ungroupQuire(quire.id))}
        />
        <Row
          label="CLOSE QUIRE"
          onPick={act(() => store().closeQuireTabs(quire.id))}
        />
      </>
    );
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[60]"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        role="menu"
        aria-label="sheaf context menu"
        onMouseDown={(e) => e.stopPropagation()}
        className="cl-mono fixed flex w-[220px] flex-col border-[1.5px] border-ink bg-paper py-1 text-[10px] uppercase tracking-[0.08em] text-ink"
        style={{ left, top }}
      >
        {content}
      </div>
    </div>,
    document.body,
  );
}

function Row({
  label,
  onPick,
  swatch,
}: {
  label: string;
  onPick: () => void;
  swatch?: string;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onPick}
      className="flex cursor-pointer items-center gap-2 px-3 py-[5px] text-left hover:bg-ink hover:text-paper"
    >
      {swatch && (
        <span
          className="inline-block h-[6px] w-[6px] flex-shrink-0"
          style={{ background: swatch }}
          aria-hidden
        />
      )}
      <span className="overflow-hidden text-ellipsis whitespace-nowrap">
        {label}
      </span>
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-rule-soft" />;
}

function NameInput({
  value,
  onChange,
  onCommit,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: (v: string) => void;
  onCancel: () => void;
}) {
  return (
    <div className="px-3 py-[5px]">
      <input
        // biome-ignore lint/a11y/noAutofocus: ephemeral menu input; focus is the entire point
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") onCommit(value);
          else if (e.key === "Escape") onCancel();
        }}
        placeholder="QUIRE NAME"
        className="w-full border border-ink/40 bg-transparent px-2 py-[3px] text-[10px] uppercase tracking-[0.08em] text-ink outline-none placeholder:text-ink-faint"
      />
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `(cd ui && bun run test src/components/codex/__tests__/SheafContextMenu.test.tsx)`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the menu into Sheaf**

In `ui/src/components/codex/Sheaf.tsx`:

5a. Add the import:

```ts
import {
  type MenuTarget,
  SheafContextMenu,
} from "#/components/codex/SheafContextMenu";
```

5b. Inside `Sheaf`, after the `hovered` state declaration, add:

```ts
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  const openMenu = (next: MenuTarget) => {
    clearOpenTimer();
    setHovered(null);
    setMenu(next);
  };
```

5c. Pass a context-menu handler to both `FolioTab` call sites (the ungrouped one and the quire-member one):

```tsx
            onContextMenu={(e, tabId) => {
              e.preventDefault();
              openMenu({ kind: "tab", tabId, x: e.clientX, y: e.clientY });
            }}
```

5d. On the quire label `<button>`, add after `onClick`:

```tsx
              onContextMenu={(e) => {
                e.preventDefault();
                openMenu({
                  kind: "quire",
                  quireId: seg.quire.id,
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
```

5e. Render the menu just before the closing `</div>` of the strip (after the footer span):

```tsx
      {menu && <SheafContextMenu target={menu} onClose={() => setMenu(null)} />}
```

5f. Extend `FolioTabProps` and the component:

```ts
  onContextMenu: (e: ReactMouseEvent, tabId: string) => void;
```

destructure `onContextMenu` in `FolioTab` and add to its `<button>`:

```tsx
      onContextMenu={(e) => onContextMenu(e, t.id)}
```

- [ ] **Step 6: Run all tests + typecheck**

Run: `(cd ui && bun run test && bun run typecheck)`
Expected: PASS / clean.

- [ ] **Step 7: Commit**

```bash
git add ui/src/components/codex/SheafContextMenu.tsx ui/src/components/codex/__tests__/SheafContextMenu.test.tsx ui/src/components/codex/Sheaf.tsx
git commit -m "feat(sheaf): right-click context menu — pin/close + quire operations"
```

---

### Task 12: Command palette quire commands

**Files:**
- Modify: `ui/src/components/codex/CommandPalette.tsx`

No component test for the palette: testing it requires mocking five modules (`useSearch`, `useTags`, `useTheme`, router, ui store) for three command rows whose actions are one-liner store calls already covered by store tests. Verified by typecheck + manual check instead.

- [ ] **Step 1: Add imports**

In `ui/src/components/codex/CommandPalette.tsx`, add:

```ts
import { deriveQuireName } from "#/store/quires";
import { useWorkspaceStore } from "#/store/workspace";
```

- [ ] **Step 2: Add the command source**

Inside `CommandPalette`, after the `tagCommands` memo, add:

```ts
  const workspaceTabs = useWorkspaceStore((s) => s.tabs);
  const quireMap = useWorkspaceStore((s) => s.quires);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);

  const quireCommands = useMemo<Command[]>(() => {
    const active = workspaceTabs.find((t) => t.id === activeTabId);
    if (!active || active.type !== "page") return [];
    const store = () => useWorkspaceStore.getState();
    const cmds: Command[] = [
      {
        kind: "cmd",
        id: "quire.new",
        title: "Quire: new from active folio",
        action: () => store().createQuire(active.id, deriveQuireName(active.label)),
      },
    ];
    for (const q of Object.values(quireMap)) {
      if (q.id === active.quireId) continue;
      cmds.push({
        kind: "cmd",
        id: `quire.add.${q.name}`,
        title: `Quire: add active folio to ${q.name}`,
        action: () => store().addTabToQuire(active.id, q.id),
      });
    }
    if (active.quireId) {
      cmds.push({
        kind: "cmd",
        id: "quire.remove",
        title: "Quire: remove active folio from quire",
        action: () => store().removeTabFromQuire(active.id),
      });
    }
    return cmds;
  }, [workspaceTabs, quireMap, activeTabId]);
```

- [ ] **Step 3: Surface them in search results only**

In the `filtered` memo, change the `verbsMatch` line from:

```ts
    const verbsMatch = verbCommands.filter(
```

to:

```ts
    const verbsMatch = [...verbCommands, ...quireCommands].filter(
```

and add `quireCommands` to that memo's dependency array. (The empty-query default list stays verbs + tags; quire commands appear when the query matches, e.g. typing "quire".)

- [ ] **Step 4: Verify**

Run: `(cd ui && bun run typecheck && bun run test)`
Expected: clean / PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/CommandPalette.tsx
git commit -m "feat(palette): quire commands — new from active, add to, remove"
```

---

### Task 13: Final verification

- [ ] **Step 1: Full gates**

Run: `(cd ui && bun run typecheck && bun run lint && bun run test)`
Expected: all clean. If Biome complains about formatting, run `(cd ui && bun run format)` and re-run the gates.

- [ ] **Step 2: Manual smoke test**

Run the backend (`cargo run -- serve`) and `(cd ui && bun run dev)`, then in the browser:

1. Open three pages; right-click a tab → NEW QUIRE… → type a name → Enter. Label cell appears with a hue; tab carries a top rule.
2. Follow a wikilink from the grouped tab → new tab joins the quire at the end of its run.
3. Click the quire label → members hide, chip shows `NAME ·n`; active tab jumps out if it was a member.
4. Ctrl-Tab → cycles without entering the collapsed quire. ⌘K → existing entries open the hidden tab and auto-expand.
5. Right-click label → RENAME, recolor swatches, CLOSE QUIRE (pin one member first: it must survive).
6. Reload → quires persist (localStorage v3). Toggle paper mode → hues swap to the light-set values.

- [ ] **Step 3: Update memory/docs**

Mark the quire design memory as implemented (`project_quire_tab_groups.md` in Claude memory) and check off this plan.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch — merge `feature/quire-tab-groups` back to `develop` or open a PR per operator preference.

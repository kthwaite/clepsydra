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
    // Fallback: all six colors are in use — pick by position modulo 6 for
    // deterministic rotation rather than always returning the same hue.
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

/** Nearest visible tab at or right of `index`, then left; null if none.
 * For close-neighbor activation pass the index in the already-reduced array.
 * For collapse activation pass the hidden tab's own index (it will be skipped). */
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

/** Ctrl-Tab target: next/previous *visible* tab in array order, wrapping. */
export function cycleTargetId(
  tabs: TabDescriptor[],
  quires: Record<string, Quire>,
  activeTabId: string | null,
  backwards: boolean,
): string | null {
  const visible = tabs.filter((t) => !isTabHidden(t, quires));
  if (visible.length === 0) return null;
  const idx = visible.findIndex((t) => t.id === activeTabId);
  // Active tab not in the candidate list (e.g. the graph tab while cycling
  // page tabs): enter the ring at its start/end instead of wrapping math.
  if (idx === -1) return visible[backwards ? visible.length - 1 : 0].id;
  if (visible.length < 2) return null;
  const next = backwards
    ? (idx - 1 + visible.length) % visible.length
    : (idx + 1) % visible.length;
  return visible[next].id;
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

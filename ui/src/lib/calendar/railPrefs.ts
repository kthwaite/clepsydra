// Folio rail calendar preferences, per device. Hidden kinds are stored (not
// visible ones), so a kind added later shows by default. Every storage access
// is guarded: private windows and blocked storage fall back to the defaults.

import { KINDS, type Kind } from "#/lib/kind";

export const HIDDEN_KINDS_KEY = "clepsydra.calendar.rail.hiddenKinds";
export const COLLAPSED_KEY = "clepsydra.calendar.rail.collapsed";

const KIND_SET: ReadonlySet<string> = new Set(KINDS);

const isKind = (v: unknown): v is Kind =>
  typeof v === "string" && KIND_SET.has(v);

export function readHiddenKinds(): Set<Kind> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_KINDS_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? new Set(parsed.filter(isKind)) : new Set();
  } catch {
    return new Set();
  }
}

export function writeHiddenKinds(kinds: ReadonlySet<Kind>): void {
  try {
    window.localStorage.setItem(
      HIDDEN_KINDS_KEY,
      JSON.stringify([...kinds].sort()),
    );
  } catch {
    // storage unavailable — the choice lasts for this visit only
  }
}

export function readCollapsed(): boolean {
  try {
    return window.localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCollapsed(collapsed: boolean): void {
  try {
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // storage unavailable — the choice lasts for this visit only
  }
}

# Shortcut Registry & Help Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralise all keyboard shortcuts in a typed registry, dispatch global ones from a single hook, and add a Vessel-styled help modal whose contents derive from the registry.

**Architecture:** A data-only registry (`ui/src/lib/shortcuts.ts`) holds every chord/label/group/scope plus `matchesChord`/`formatChord` helpers. A `useGlobalShortcuts` hook (mounted once in `__root.tsx`) owns the only global keydown listener and yields to anything that already called `preventDefault()` (so Slate editor marks win ⌘D/⌘I/⌘, conflicts). SlateEditor and Folio keep their own dispatch but match chords via the registry. The help modal renders `shortcutsByGroup()`.

**Tech Stack:** React 19, Zustand, TanStack Router, Vitest + Testing Library, Tailwind v4 (Vessel tokens). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-06-10-shortcut-registry-design.md`

**Conventions:** All frontend commands run from `ui/`. Path alias `#/` = `ui/src/`. Format with `bun run format` before each commit.

**Branch:** work on `feature/shortcut-registry` off `develop` (`git checkout develop && git checkout -b feature/shortcut-registry`). The working tree currently has unrelated dirty files — do not stage anything you didn't create/modify for this plan; always `git add` explicit paths.

**Known intentional behaviour changes** (do not "fix" these back):
1. The six phantom palette shortcuts (⌘H ⌘D ⌘G ⌘I ⌘, ⌘\) become real global bindings.
2. Inside the editor, Ctrl+Tab no longer indents (the indent chord is now *bare* Tab, no modifiers), so Ctrl+Tab falls through to tab cycling. Previously both fired — a latent double-fire bug.
3. Editor mark chords now match case-insensitively, so ⌘⇧B toggles bold (previously a no-op because `e.key === "B"` missed `case "b"`).
4. Hard-coded `⌘` glyphs become platform-aware (`Ctrl+…` off-Mac).

---

### Task 1: Shortcut registry + helpers

**Files:**
- Create: `ui/src/lib/shortcuts.ts`
- Test: `ui/src/lib/shortcuts.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/lib/shortcuts.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  GLOBAL_SHORTCUT_IDS,
  SHORTCUTS,
  formatChord,
  matchesChord,
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
    expect(matchesChord(ev("B", { metaKey: true, shiftKey: true }), chord)).toBe(
      true,
    );
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
    const listed = shortcutsByGroup().flatMap(([, defs]) => defs.map((d) => d.id));
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
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `ui/`): `bun run test src/lib/shortcuts.test.ts`
Expected: FAIL — cannot resolve `#/lib/shortcuts`.

- [ ] **Step 3: Implement the registry**

Create `ui/src/lib/shortcuts.ts`:

```ts
/**
 * Central shortcut registry — the single source of truth for key chords,
 * labels, grouping, and dispatch scope. The help modal, command-palette key
 * hints, the global dispatcher (useGlobalShortcuts), SlateEditor, and Folio
 * all read from here so handlers and documentation cannot drift.
 *
 * Spec: docs/superpowers/specs/2026-06-10-shortcut-registry-design.md
 */

export type Chord = {
  /** KeyboardEvent.key — single chars lowercase ("k", "/", ","), named keys
   *  verbatim ("Tab", "Enter", "ArrowUp"). */
  key: string;
  /** ⌘ on Mac, Ctrl elsewhere — matches metaKey || ctrlKey. */
  mod?: boolean;
  /** Ctrl specifically on every platform (Ctrl+Tab). Mutually exclusive
   *  with mod. */
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutGroup = "Navigate" | "Workspace" | "Editor";
export type ShortcutScope = "global" | "editor" | "contextual";

export type ShortcutDef = {
  chord: Chord;
  /** Help-modal row label. */
  label: string;
  group: ShortcutGroup;
  /** "global" → dispatched by useGlobalShortcuts; "editor" → SlateEditor;
   *  "contextual" → a component-local listener (Folio ⌘S). */
  scope: ShortcutScope;
  /** Dimmed annotation in the help modal. */
  note?: string;
};

export const SHORTCUTS = {
  "palette.toggle": {
    chord: { key: "k", mod: true },
    label: "Command console",
    group: "Navigate",
    scope: "global",
  },
  "nav.atrium": {
    chord: { key: "h", mod: true },
    label: "Open Atrium",
    group: "Navigate",
    scope: "global",
  },
  "nav.diurnal": {
    chord: { key: "d", mod: true },
    label: "Open Diurnal",
    group: "Navigate",
    scope: "global",
    note: "outside the editor",
  },
  "nav.constellation": {
    chord: { key: "g", mod: true },
    label: "Open Constellation (graph)",
    group: "Navigate",
    scope: "global",
  },
  "nav.gazetteer": {
    chord: { key: "i", mod: true },
    label: "Open Gazetteer (index)",
    group: "Navigate",
    scope: "global",
    note: "outside the editor",
  },
  "app.inscribe": {
    chord: { key: "n", mod: true },
    label: "Inscribe new folio",
    group: "Workspace",
    scope: "global",
  },
  "app.settings": {
    chord: { key: ",", mod: true },
    label: "Status / preferences",
    group: "Workspace",
    scope: "global",
    note: "outside the editor",
  },
  "app.themeToggle": {
    chord: { key: "\\", mod: true },
    label: "Toggle dark / paper mode",
    group: "Workspace",
    scope: "global",
  },
  "app.shortcutHelp": {
    chord: { key: "/", mod: true },
    label: "Keyboard shortcuts",
    group: "Workspace",
    scope: "global",
  },
  "tabs.close": {
    chord: { key: "w", mod: true },
    label: "Close active tab",
    group: "Workspace",
    scope: "global",
    note: "workspace view",
  },
  "tabs.next": {
    chord: { key: "Tab", ctrl: true },
    label: "Next tab",
    group: "Workspace",
    scope: "global",
    note: "workspace view",
  },
  "tabs.prev": {
    chord: { key: "Tab", ctrl: true, shift: true },
    label: "Previous tab",
    group: "Workspace",
    scope: "global",
    note: "workspace view",
  },
  "folio.save": {
    chord: { key: "s", mod: true },
    label: "Save folio",
    group: "Workspace",
    scope: "contextual",
    note: "with a folio open",
  },
  "editor.indent": {
    chord: { key: "Tab" },
    label: "Indent list item",
    group: "Editor",
    scope: "editor",
  },
  "editor.outdent": {
    chord: { key: "Tab", shift: true },
    label: "Outdent list item",
    group: "Editor",
    scope: "editor",
  },
  "editor.moveUp": {
    chord: { key: "ArrowUp", alt: true },
    label: "Move block up",
    group: "Editor",
    scope: "editor",
  },
  "editor.moveDown": {
    chord: { key: "ArrowDown", alt: true },
    label: "Move block down",
    group: "Editor",
    scope: "editor",
  },
  "editor.checkbox": {
    chord: { key: "Enter", mod: true },
    label: "Toggle checkbox",
    group: "Editor",
    scope: "editor",
  },
  "editor.mark.bold": {
    chord: { key: "b", mod: true },
    label: "Bold",
    group: "Editor",
    scope: "editor",
  },
  "editor.mark.italic": {
    chord: { key: "i", mod: true },
    label: "Italic",
    group: "Editor",
    scope: "editor",
  },
  "editor.mark.underline": {
    chord: { key: "u", mod: true },
    label: "Underline",
    group: "Editor",
    scope: "editor",
  },
  "editor.mark.code": {
    chord: { key: "e", mod: true },
    label: "Inline code",
    group: "Editor",
    scope: "editor",
  },
  "editor.mark.strikethrough": {
    chord: { key: "d", mod: true },
    label: "Strikethrough",
    group: "Editor",
    scope: "editor",
  },
  "editor.mark.superscript": {
    chord: { key: ".", mod: true },
    label: "Superscript",
    group: "Editor",
    scope: "editor",
  },
  "editor.mark.subscript": {
    chord: { key: ",", mod: true },
    label: "Subscript",
    group: "Editor",
    scope: "editor",
  },
} as const satisfies Record<string, ShortcutDef>;

export type ShortcutId = keyof typeof SHORTCUTS;

/** Ids the global dispatcher must handle — derived from scope, so adding a
 *  global entry without a dispatcher handler is a compile error. */
export type GlobalShortcutId = {
  [K in ShortcutId]: (typeof SHORTCUTS)[K]["scope"] extends "global"
    ? K
    : never;
}[ShortcutId];

export const GLOBAL_SHORTCUT_IDS = (
  Object.keys(SHORTCUTS) as ShortcutId[]
).filter((id): id is GlobalShortcutId => SHORTCUTS[id].scope === "global");

/** Structural subset of KeyboardEvent — accepts native and React events. */
type KeyLike = Pick<
  KeyboardEvent,
  "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"
>;

/** The one chord-matching predicate. Letters compare case-insensitively and
 *  shift is only enforced on letters when the chord declares it (so ⌘⇧B
 *  still toggles bold). Non-letter keys enforce shift strictly so Ctrl+Tab
 *  and Ctrl+Shift+Tab stay distinct. */
export function matchesChord(e: KeyLike, chord: Chord): boolean {
  const want =
    chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;
  const got = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (got !== want) return false;

  if (chord.ctrl) {
    if (!e.ctrlKey || e.metaKey) return false;
  } else if ((chord.mod ?? false) !== (e.metaKey || e.ctrlKey)) {
    return false;
  }
  if ((chord.alt ?? false) !== e.altKey) return false;

  const isLetter = /^[a-z]$/.test(want);
  if (!isLetter || chord.shift !== undefined) {
    if ((chord.shift ?? false) !== e.shiftKey) return false;
  }
  return true;
}

function detectMac(): boolean {
  if (typeof navigator === "undefined") return false;
  const nav = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return /mac/i.test(nav.userAgentData?.platform ?? nav.platform ?? "");
}

export const IS_MAC = detectMac();

const KEY_GLYPHS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Enter: "⏎",
  Escape: "Esc",
};

/** Platform-aware display: "⌘K" on Mac, "Ctrl+K" elsewhere. */
export function formatChord(chord: Chord, isMac: boolean = IS_MAC): string {
  const mods: string[] = [];
  if (chord.ctrl) mods.push(isMac ? "⌃" : "Ctrl");
  if (chord.alt) mods.push(isMac ? "⌥" : "Alt");
  if (chord.shift) mods.push(isMac ? "⇧" : "Shift");
  if (chord.mod) mods.push(isMac ? "⌘" : "Ctrl");
  const glyph =
    KEY_GLYPHS[chord.key] ??
    (chord.key.length === 1 ? chord.key.toUpperCase() : chord.key);
  return [...mods, glyph].join(isMac ? "" : "+");
}

const GROUP_ORDER: ShortcutGroup[] = ["Navigate", "Workspace", "Editor"];

/** Registry entries in help-modal order, grouped. */
export function shortcutsByGroup(): Array<
  [ShortcutGroup, Array<{ id: ShortcutId; def: ShortcutDef }>]
> {
  const ids = Object.keys(SHORTCUTS) as ShortcutId[];
  return GROUP_ORDER.map((group) => [
    group,
    ids
      .filter((id) => SHORTCUTS[id].group === group)
      .map((id) => ({ id, def: SHORTCUTS[id] })),
  ]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `ui/`): `bun run test src/lib/shortcuts.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Typecheck, format, commit**

```bash
bun run typecheck && bun run format
git add ui/src/lib/shortcuts.ts ui/src/lib/shortcuts.test.ts
git commit -m "feat(ui): add central shortcut registry with chord match/format helpers"
```

---

### Task 2: Shortcut-help state in the UI store

**Files:**
- Modify: `ui/src/store/ui.ts`

(No dedicated test — the store has no existing tests and the additions are
two trivial setters; they're exercised by the dispatcher and modal tests in
Tasks 3 and 5.)

- [ ] **Step 1: Add state + actions**

In `ui/src/store/ui.ts`, extend `UiState` (after the `isInscribeOpen` /
`isBooting` fields and matching actions):

```ts
interface UiState {
  isSettingsOpen: boolean;
  activeSettingsSection: SettingsSection;
  isSearchOpen: boolean;
  isInscribeOpen: boolean;
  isShortcutHelpOpen: boolean;
  isBooting: boolean;
  openSettings: (section?: SettingsSection) => void;
  closeSettings: () => void;
  setActiveSettingsSection: (section: SettingsSection) => void;
  openSearch: () => void;
  closeSearch: () => void;
  toggleSearch: () => void;
  setSearchOpen: (open: boolean) => void;
  openInscribe: () => void;
  closeInscribe: () => void;
  openShortcutHelp: () => void;
  closeShortcutHelp: () => void;
  runBoot: () => void;
  endBoot: () => void;
}
```

And in the `create<UiState>` body add:

```ts
  isShortcutHelpOpen: false,
  // ...existing fields...
  openShortcutHelp: () => set({ isShortcutHelpOpen: true }),
  closeShortcutHelp: () => set({ isShortcutHelpOpen: false }),
```

- [ ] **Step 2: Typecheck and commit**

```bash
bun run typecheck && bun run format
git add ui/src/store/ui.ts
git commit -m "feat(ui): add shortcut-help modal state to ui store"
```

---

### Task 3: Global dispatcher hook

**Files:**
- Create: `ui/src/hooks/useGlobalShortcuts.tsx`
- Test: `ui/src/hooks/useGlobalShortcuts.test.tsx`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/hooks/useGlobalShortcuts.test.tsx`:

```tsx
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { navigateMock, openTabMock, toggleThemeMock } = vi.hoisted(() => ({
  navigateMock: vi.fn(),
  openTabMock: vi.fn(),
  toggleThemeMock: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));
vi.mock("#/components/ThemeProvider", () => ({
  useTheme: () => ({ toggle: toggleThemeMock }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { useGlobalShortcuts } from "#/hooks/useGlobalShortcuts";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

function press(
  key: string,
  mods: Partial<{
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  }> = {},
  { prevented = false } = {},
) {
  const e = new KeyboardEvent("keydown", {
    key,
    cancelable: true,
    bubbles: true,
    ...mods,
  });
  if (prevented) e.preventDefault();
  window.dispatchEvent(e);
  return e;
}

describe("useGlobalShortcuts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUiStore.setState({
      isSearchOpen: false,
      isInscribeOpen: false,
      isShortcutHelpOpen: false,
      isSettingsOpen: false,
    });
    useWorkspaceStore.setState({ tabs: [], activeTabId: null });
    window.history.pushState({}, "", "/");
  });

  it("⌘K toggles the command palette", () => {
    renderHook(() => useGlobalShortcuts());
    press("k", { metaKey: true });
    expect(useUiStore.getState().isSearchOpen).toBe(true);
    press("k", { ctrlKey: true });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });

  it("⌘N opens inscribe and ⌘/ opens shortcut help", () => {
    renderHook(() => useGlobalShortcuts());
    press("n", { metaKey: true });
    expect(useUiStore.getState().isInscribeOpen).toBe(true);
    press("/", { metaKey: true });
    expect(useUiStore.getState().isShortcutHelpOpen).toBe(true);
  });

  it("binds the previously-phantom navigation chords", () => {
    renderHook(() => useGlobalShortcuts());
    press("h", { metaKey: true });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
    press("d", { metaKey: true });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/journal" });
    press("i", { metaKey: true });
    expect(navigateMock).toHaveBeenCalledWith({ to: "/gazetteer" });
    press("g", { metaKey: true });
    expect(openTabMock).toHaveBeenCalledWith("graph");
    press("\\", { metaKey: true });
    expect(toggleThemeMock).toHaveBeenCalled();
  });

  it("⌘, opens settings at appearance", () => {
    renderHook(() => useGlobalShortcuts());
    press(",", { metaKey: true });
    const s = useUiStore.getState();
    expect(s.isSettingsOpen).toBe(true);
    expect(s.activeSettingsSection).toBe("appearance");
  });

  it("yields to already-handled events (editor conflict policy)", () => {
    renderHook(() => useGlobalShortcuts());
    press("d", { metaKey: true }, { prevented: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("cycles and closes tabs only in the workspace view", () => {
    renderHook(() => useGlobalShortcuts());
    useWorkspaceStore.setState({
      tabs: [
        { id: "a", type: "page", label: "A" },
        { id: "b", type: "page", label: "B" },
        { id: "c", type: "page", label: "C" },
      ],
      activeTabId: "a",
    });

    // outside /workspace: ignored, not even preventDefault
    const ignored = press("Tab", { ctrlKey: true });
    expect(ignored.defaultPrevented).toBe(false);
    expect(useWorkspaceStore.getState().activeTabId).toBe("a");

    window.history.pushState({}, "", "/workspace");
    press("Tab", { ctrlKey: true });
    expect(useWorkspaceStore.getState().activeTabId).toBe("b");
    press("Tab", { ctrlKey: true, shiftKey: true });
    expect(useWorkspaceStore.getState().activeTabId).toBe("a");
    // wrap-around backwards
    press("Tab", { ctrlKey: true, shiftKey: true });
    expect(useWorkspaceStore.getState().activeTabId).toBe("c");

    press("w", { metaKey: true });
    expect(
      useWorkspaceStore.getState().tabs.find((t) => t.id === "c"),
    ).toBeUndefined();
  });

  it("removes its listener on unmount", () => {
    const { unmount } = renderHook(() => useGlobalShortcuts());
    unmount();
    press("k", { metaKey: true });
    expect(useUiStore.getState().isSearchOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `ui/`): `bun run test src/hooks/useGlobalShortcuts.test.tsx`
Expected: FAIL — cannot resolve `#/hooks/useGlobalShortcuts`.

- [ ] **Step 3: Implement the hook**

Create `ui/src/hooks/useGlobalShortcuts.tsx`:

```tsx
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo } from "react";
import { useTheme } from "#/components/ThemeProvider";
import { useOpenTab } from "#/hooks/useOpenTab";
import {
  GLOBAL_SHORTCUT_IDS,
  type GlobalShortcutId,
  SHORTCUTS,
  matchesChord,
} from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";

type Binding = {
  run: () => void;
  /** Gate for route-scoped bindings; a matched-but-gated chord is left to
   *  the browser (no preventDefault), preserving pre-registry behaviour. */
  when?: () => boolean;
};

const inWorkspace = () => window.location.pathname.startsWith("/workspace");

function cycleTab(dir: 1 | -1) {
  const { tabs, activeTabId, activateTab } = useWorkspaceStore.getState();
  if (tabs.length < 2) return;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  activateTab(tabs[(idx + dir + tabs.length) % tabs.length].id);
}

/**
 * The app's single global keydown dispatcher. Mounted once (via
 * <GlobalShortcuts /> in __root.tsx). Skips events something else already
 * handled (e.defaultPrevented) — that one rule is the whole conflict policy:
 * inside the editor ⌘D/⌘I/⌘, mean marks; everywhere else they navigate.
 */
export function useGlobalShortcuts() {
  const navigate = useNavigate();
  const toggleSearch = useUiStore((s) => s.toggleSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openSettings = useUiStore((s) => s.openSettings);
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
  const { toggle: toggleTheme } = useTheme();
  const openTab = useOpenTab();

  // Exhaustive over GlobalShortcutId: adding a `scope: "global"` registry
  // entry without a binding here is a compile error.
  const bindings = useMemo<Record<GlobalShortcutId, Binding>>(
    () => ({
      "palette.toggle": { run: toggleSearch },
      "nav.atrium": { run: () => navigate({ to: "/" }) },
      "nav.diurnal": { run: () => navigate({ to: "/journal" }) },
      "nav.constellation": { run: () => openTab("graph") },
      "nav.gazetteer": { run: () => navigate({ to: "/gazetteer" }) },
      "app.inscribe": { run: openInscribe },
      "app.settings": { run: () => openSettings("appearance") },
      "app.themeToggle": { run: toggleTheme },
      "app.shortcutHelp": { run: openShortcutHelp },
      "tabs.close": {
        when: inWorkspace,
        run: () => {
          const { activeTabId, closeTab } = useWorkspaceStore.getState();
          if (activeTabId) closeTab(activeTabId);
        },
      },
      "tabs.next": { when: inWorkspace, run: () => cycleTab(1) },
      "tabs.prev": { when: inWorkspace, run: () => cycleTab(-1) },
    }),
    [
      navigate,
      toggleSearch,
      openInscribe,
      openSettings,
      openShortcutHelp,
      toggleTheme,
      openTab,
    ],
  );

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      for (const id of GLOBAL_SHORTCUT_IDS) {
        if (!matchesChord(e, SHORTCUTS[id].chord)) continue;
        const binding = bindings[id];
        if (binding.when && !binding.when()) return;
        e.preventDefault();
        binding.run();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bindings]);
}

/** Render-nothing mount point for the dispatcher. */
export function GlobalShortcuts() {
  useGlobalShortcuts();
  return null;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run (from `ui/`): `bun run test src/hooks/useGlobalShortcuts.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck, format, commit**

```bash
bun run typecheck && bun run format
git add ui/src/hooks/useGlobalShortcuts.tsx ui/src/hooks/useGlobalShortcuts.test.tsx
git commit -m "feat(ui): add global shortcut dispatcher hook"
```

---

### Task 4: Mount dispatcher, delete the scattered listeners

**Files:**
- Modify: `ui/src/routes/__root.tsx`
- Modify: `ui/src/components/codex/CodexFrame.tsx` (delete ⌘N effect)
- Modify: `ui/src/components/codex/CommandPalette.tsx` (delete ⌘K effect)
- Modify: `ui/src/routes/workspace.tsx` (delete keydown effect)

- [ ] **Step 1: Mount `<GlobalShortcuts />` in the root route**

In `ui/src/routes/__root.tsx`, add the import and mount it alongside the
other overlay components:

```tsx
import { GlobalShortcuts } from "#/hooks/useGlobalShortcuts";
```

```tsx
      <ReadingProgressProvider>
        <CodexFrame>
          <Outlet />
        </CodexFrame>
        <GlobalShortcuts />
        <CommandPalette />
        <SettingsModal />
        <InscribeModal />
        <LinkPreviewLayer />
        <BootSequence />
      </ReadingProgressProvider>
```

(`__root.tsx` renders inside the router and below `ThemeProvider`, so
`useNavigate`/`useTheme` are available to the hook.)

- [ ] **Step 2: Delete the absorbed listeners**

1. `ui/src/components/codex/CodexFrame.tsx` — delete the ⌘N effect
   (lines ~79-90, the `// ⌘N → INTAKE …` comment plus the `useEffect` that
   adds the keydown listener). `openInscribe` is still used by the palette
   verb via the store, but check: if `openInscribe` is now unused in this
   file, remove its `useUiStore` selector line too (typecheck will tell you —
   `noUnusedLocals` is on).
2. `ui/src/components/codex/CommandPalette.tsx` — delete the `// ⌘K / Ctrl+K`
   `useEffect` (lines ~57-67). The `toggle` selector becomes unused — remove
   `const toggle = useUiStore((s) => s.toggleSearch);` as well.
3. `ui/src/routes/workspace.tsx` — delete the entire keydown `useEffect` and
   now-unused imports; the file shrinks to:

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { TabContent } from "#/components/TabContent";

export const Route = createFileRoute("/workspace")({
  component: TabContent,
});
```

- [ ] **Step 3: Verify**

Run (from `ui/`): `bun run typecheck && bun run test`
Expected: PASS — typecheck clean (no unused locals), full suite green.

Then manually grep that no stray global listeners remain:

```bash
grep -rn 'addEventListener("keydown"' ui/src --include='*.tsx' --include='*.ts' | grep -v test
```

Expected remaining hits ONLY in: `useGlobalShortcuts.tsx`, `Folio.tsx`,
`BootSequence.tsx`, `ui/src/components/ui/editor-suggestion-popover.tsx`
(document-level, widget-internal). Anything else is a missed deletion.

- [ ] **Step 4: Format and commit**

```bash
bun run format
git add ui/src/routes/__root.tsx ui/src/routes/workspace.tsx ui/src/components/codex/CodexFrame.tsx ui/src/components/codex/CommandPalette.tsx
git commit -m "refactor(ui): dispatch global shortcuts centrally, drop scattered listeners"
```

---

### Task 5: Shortcut help modal

**Files:**
- Create: `ui/src/components/codex/ShortcutHelpModal.tsx`
- Test: `ui/src/components/codex/__tests__/ShortcutHelpModal.test.tsx`
- Modify: `ui/src/routes/__root.tsx` (mount)

- [ ] **Step 1: Write the failing tests**

Create `ui/src/components/codex/__tests__/ShortcutHelpModal.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { ShortcutHelpModal } from "#/components/codex/ShortcutHelpModal";
import { SHORTCUTS } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";

describe("ShortcutHelpModal", () => {
  beforeEach(() => {
    useUiStore.setState({ isShortcutHelpOpen: true });
  });

  it("renders nothing when closed", () => {
    useUiStore.setState({ isShortcutHelpOpen: false });
    render(<ShortcutHelpModal />);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every registry entry exactly once, under group headers", () => {
    render(<ShortcutHelpModal />);
    const dialog = screen.getByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toBeInTheDocument();

    for (const def of Object.values(SHORTCUTS)) {
      expect(screen.getAllByText(def.label).length).toBeGreaterThanOrEqual(1);
    }
    // one row (and one <kbd>) per registry entry
    expect(dialog.querySelectorAll("kbd").length).toBe(
      Object.keys(SHORTCUTS).length,
    );
    for (const group of ["NAVIGATE", "WORKSPACE", "EDITOR"]) {
      expect(screen.getByText(group)).toBeInTheDocument();
    }
  });

  it("shows notes where defined", () => {
    render(<ShortcutHelpModal />);
    expect(screen.getAllByText("outside the editor").length).toBe(3);
  });

  it("closes on Escape", async () => {
    render(<ShortcutHelpModal />);
    await userEvent.keyboard("{Escape}");
    expect(useUiStore.getState().isShortcutHelpOpen).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run (from `ui/`): `bun run test src/components/codex/__tests__/ShortcutHelpModal.test.tsx`
Expected: FAIL — cannot resolve `#/components/codex/ShortcutHelpModal`.

- [ ] **Step 3: Implement the modal**

Create `ui/src/components/codex/ShortcutHelpModal.tsx` (chrome mirrors
`CommandPalette.tsx`: hard-edged ink-bordered panel, `cl-mono` labels,
bordered keycaps, zero radius, token colours only):

```tsx
import { useEffect } from "react";
import { formatChord, shortcutsByGroup } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";

export function ShortcutHelpModal() {
  const open = useUiStore((s) => s.isShortcutHelpOpen);
  const close = useUiStore((s) => s.closeShortcutHelp);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, close]);

  if (!open) return null;

  return (
    <div
      onMouseDown={close}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/35 pt-20"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Keyboard shortcuts"
        className="flex w-[92%] max-w-[560px] flex-col border-[1.5px] border-ink bg-paper font-body text-ink"
      >
        {/* header */}
        <div className="flex items-center gap-[10px] border-b border-ink px-[14px] py-[8px]">
          <span className="cl-mono text-[9px] tracking-[0.16em] text-ink-mute">
            REGISTER
          </span>
          <span className="cl-mono text-[13px] font-bold tracking-[0.08em] text-accent">
            KEYS
          </span>
          <span className="flex-1" />
          <span className="cl-mono border border-ink/40 px-[6px] py-[1px] text-[10px] tracking-[0.08em] text-ink-mute">
            ESC
          </span>
        </div>
        {/* groups */}
        <div className="cl-noscroll max-h-[440px] overflow-auto px-[14px] py-[10px]">
          {shortcutsByGroup().map(([group, defs]) => (
            <section key={group} className="mb-[14px] last:mb-0">
              <h3 className="cl-mono mb-[5px] text-[9px] uppercase tracking-[0.18em] text-accent">
                {group}
              </h3>
              {defs.map(({ id, def }) => (
                <div
                  key={id}
                  className="flex items-baseline gap-[10px] py-[2px]"
                >
                  <span className="cl-mono text-[11px] tracking-[0.02em]">
                    {def.label}
                  </span>
                  {def.note && (
                    <span className="cl-mono text-[9px] tracking-[0.06em] text-ink-faint">
                      {def.note}
                    </span>
                  )}
                  <span className="flex-1 border-b border-dotted border-ink/15" />
                  <kbd className="cl-mono border border-ink/40 px-[6px] py-[1px] text-[10px] tracking-[0.08em] text-ink-mute">
                    {formatChord(def.chord)}
                  </kbd>
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Mount it in `__root.tsx`**

```tsx
import { ShortcutHelpModal } from "#/components/codex/ShortcutHelpModal";
```

…and render it next to the other overlays:

```tsx
        <GlobalShortcuts />
        <CommandPalette />
        <SettingsModal />
        <InscribeModal />
        <ShortcutHelpModal />
        <LinkPreviewLayer />
        <BootSequence />
```

- [ ] **Step 5: Run tests to verify they pass**

Run (from `ui/`): `bun run test src/components/codex/__tests__/ShortcutHelpModal.test.tsx`
Expected: PASS.

- [ ] **Step 6: Typecheck, format, commit**

```bash
bun run typecheck && bun run format
git add ui/src/components/codex/ShortcutHelpModal.tsx ui/src/components/codex/__tests__/ShortcutHelpModal.test.tsx ui/src/routes/__root.tsx
git commit -m "feat(ui): add registry-derived keyboard-shortcut help modal (⌘/)"
```

---

### Task 6: Command palette de-drift

**Files:**
- Modify: `ui/src/components/codex/CommandPalette.tsx`

- [ ] **Step 1: Derive key hints from the registry, add the help command**

Add imports:

```tsx
import { SHORTCUTS, formatChord } from "#/lib/shortcuts";
```

Add the store selector next to the others:

```tsx
  const openShortcutHelp = useUiStore((s) => s.openShortcutHelp);
```

Replace the `verbCommands` array's hard-coded `id` hints with
`formatChord(...)` and append the help command. Full replacement of the
array contents (deps list gains `openShortcutHelp`):

```tsx
  const verbCommands = useMemo<Command[]>(
    () => [
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["nav.atrium"].chord),
        title: "Open Atrium",
        action: () => navigate({ to: "/" }),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["nav.diurnal"].chord),
        title: "Open Diurnal",
        action: () => navigate({ to: "/journal" }),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["nav.constellation"].chord),
        title: "Open Constellation (graph)",
        action: () => {
          openTab("graph");
        },
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["nav.gazetteer"].chord),
        title: "Open Gazetteer (index)",
        action: () => navigate({ to: "/gazetteer" }),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["app.inscribe"].chord),
        title: "Inscribe new folio",
        action: () => openInscribe(),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["app.settings"].chord),
        title: "Open Status / preferences",
        action: () => openSettings("appearance"),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["app.themeToggle"].chord),
        title: "Toggle dark mode",
        action: () => toggleTheme(),
      },
      {
        kind: "cmd",
        id: formatChord(SHORTCUTS["app.shortcutHelp"].chord),
        title: "Keyboard shortcuts",
        action: () => openShortcutHelp(),
      },
      {
        kind: "cmd",
        id: "sys.chrome",
        title: "Toggle diegetic chrome",
        action: () => setDiegetic(!diegetic),
      },
      {
        kind: "cmd",
        id: "sys.boot",
        title: "Re-run boot sequence",
        action: () => runBoot(),
      },
    ],
    [
      navigate,
      openTab,
      toggleTheme,
      openInscribe,
      openSettings,
      openShortcutHelp,
      runBoot,
      diegetic,
      setDiegetic,
    ],
  );
```

(`sys.chrome` and `sys.boot` keep machine-id hints — they have no chord.)

- [ ] **Step 2: Verify and commit**

Run (from `ui/`): `bun run typecheck && bun run test`
Expected: PASS.

```bash
bun run format
git add ui/src/components/codex/CommandPalette.tsx
git commit -m "refactor(ui): derive command-palette key hints from shortcut registry"
```

---

### Task 7: Match Folio + SlateEditor chords via the registry

**Files:**
- Modify: `ui/src/components/codex/Folio.tsx:98-110`
- Modify: `ui/src/editor/SlateEditor.tsx:309-430` (`handleKeyDown`)

No behaviour change is intended here beyond items 2-3 of the "known
intentional behaviour changes" list at the top of this plan. Existing
editor/Folio tests are the safety net.

- [ ] **Step 1: Folio ⌘S via registry**

In `ui/src/components/codex/Folio.tsx`, add the import:

```tsx
import { SHORTCUTS, matchesChord } from "#/lib/shortcuts";
```

and change the listener body (keep the explanatory comment above the
effect):

```tsx
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (matchesChord(e, SHORTCUTS["folio.save"].chord)) {
        e.preventDefault();
        saveNow();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saveNow]);
```

- [ ] **Step 2: SlateEditor chords via registry**

In `ui/src/editor/SlateEditor.tsx`, add the import:

```tsx
import { SHORTCUTS, matchesChord } from "#/lib/shortcuts";
```

Replace the body of `handleKeyDown` (currently lines ~309-430). The
combobox passthrough block at the top is UNCHANGED; everything below it
becomes registry-matched. Full replacement:

```tsx
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (wikilinkTrigger || blockRefTrigger || slashTrigger) {
      if (
        ["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)
      ) {
        event.preventDefault();
        return;
      }
    }

    // --- Outliner keybindings ---
    if (matchesChord(event, SHORTCUTS["editor.indent"].chord)) {
      event.preventDefault();
      indentListItem(editor);
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.outdent"].chord)) {
      event.preventDefault();
      outdentListItem(editor);
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.moveUp"].chord)) {
      event.preventDefault();
      moveBlockUp(editor);
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.moveDown"].chord)) {
      event.preventDefault();
      moveBlockDown(editor);
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.checkbox"].chord)) {
      event.preventDefault();
      toggleCheckbox(editor);
      return;
    }

    // --- Save ---
    if (matchesChord(event, SHORTCUTS["folio.save"].chord)) {
      event.preventDefault();
      onSaveNow();
      return;
    }

    // --- Formatting marks ---
    if (matchesChord(event, SHORTCUTS["editor.mark.bold"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.bold) {
        Editor.removeMark(editor, "bold");
      } else {
        Editor.addMark(editor, "bold", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.italic"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.italic) {
        Editor.removeMark(editor, "italic");
      } else {
        Editor.addMark(editor, "italic", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.underline"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.underline) {
        Editor.removeMark(editor, "underline");
      } else {
        Editor.addMark(editor, "underline", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.code"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.code) {
        Editor.removeMark(editor, "code");
      } else {
        Editor.addMark(editor, "code", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.strikethrough"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.strikethrough) {
        Editor.removeMark(editor, "strikethrough");
      } else {
        Editor.addMark(editor, "strikethrough", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.superscript"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.superscript) {
        Editor.removeMark(editor, "superscript");
      } else {
        Editor.removeMark(editor, "subscript");
        Editor.addMark(editor, "superscript", true);
      }
      return;
    }
    if (matchesChord(event, SHORTCUTS["editor.mark.subscript"].chord)) {
      event.preventDefault();
      const marks = Editor.marks(editor);
      if (marks?.subscript) {
        Editor.removeMark(editor, "subscript");
      } else {
        Editor.removeMark(editor, "superscript");
        Editor.addMark(editor, "subscript", true);
      }
      return;
    }
  };
```

Note the editor's ⌘S branch reuses `SHORTCUTS["folio.save"].chord` — per
spec it is NOT a separate registry entry.

- [ ] **Step 3: Run the full suite**

Run (from `ui/`): `bun run typecheck && bun run test`
Expected: PASS — in particular the existing editor/outliner/Folio tests.
If an editor test fails on Tab handling, check whether it synthesises
Ctrl+Tab expecting indent — that expectation changed intentionally (see
header); update the test to bare Tab.

- [ ] **Step 4: Format and commit**

```bash
bun run format
git add ui/src/components/codex/Folio.tsx ui/src/editor/SlateEditor.tsx
git commit -m "refactor(editor): match Folio and Slate chords via shortcut registry"
```

---

### Task 8: Final verification

- [ ] **Step 1: Full gate**

Run (from `ui/`):

```bash
bun run typecheck && bun run lint && bun run test && bun run build
```

Expected: all four succeed.

- [ ] **Step 2: Drift audit**

Confirm no hard-coded chord strings remain outside the registry:

```bash
grep -rn 'metaKey || e.ctrlKey\|e.metaKey || e.ctrlKey\|event.metaKey || event.ctrlKey' ui/src --include='*.tsx' --include='*.ts' | grep -v shortcuts | grep -v test
```

Expected: no hits. Also re-run the listener grep from Task 4 Step 3.

- [ ] **Step 3: Manual smoke test (requires running backend + `bun run dev`)**

- ⌘/ opens the help modal; Escape and backdrop-click close it.
- ⌘K palette shows "Keyboard shortcuts" with the right hint and opens it.
- ⌘H/⌘D/⌘G/⌘I navigate; ⌘, opens settings; ⌘\ toggles theme.
- In the editor: ⌘D strikes through (does NOT navigate to Diurnal), ⌘I
  italicises, ⌘, subscripts; outside the editor the same chords navigate.
- Tab/Shift+Tab still indent/outdent lists; Ctrl+Tab cycles tabs even with
  the editor focused.

- [ ] **Step 4: Commit any straggling fixes, then hand off**

Use superpowers:finishing-a-development-branch to merge/PR
`feature/shortcut-registry` back to `develop`.

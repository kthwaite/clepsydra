# Stone & Lamp Phase 2a — Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Vessel header and footer with the Stone & Lamp shell: wordmark + core three + Contents, a simplified footer with sync and save state, the Contents sheet, sidebar shortcuts, and the removal of the diegetic setting.

**Architecture:** `VIEW_REGISTRY` gains `group`, `description` and `shortcut`, and its labels become title case; `CORE_NAV` replaces `DESKTOP_NAV`. `ContentsMenu` is a React Aria popover built from the registry. The footer reads two new sources: `useSaveStatus` (TanStack mutation cache) and a `footerContext` store that the active Folio writes. Folio's collapsed state moves into a small zustand store, so global shortcuts can toggle it. Chords can match `KeyboardEvent.code`, because ⌥ and ⇧ change `key` on macOS.

**Tech Stack:** React 19, TanStack Router/Query v5, zustand 5, react-aria-components 1.20, Tailwind v4, Vitest + Testing Library, lucide-react.

**Spec:** `docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md` (§2 decisions 7, 8, 12; §4 "Diegetic setting"; §5.1; §5.2; §9 Q4, Q5).

**User rulings (2026-09-25), binding on this plan:**
- Phase 2 splits into 2a (this plan: shell) and 2b (Sheaf C3). The Sheaf is not touched here.
- The footer ships its slot now, with Folio's context and a default for every other screen. Tables publish row range in a later phase.
- The Q5 sidebar shortcuts and the theme-toggle move ship in 2a.

## Global Constraints

- No monospace outside code: no new `cl-mono`, `font-mono`, `uppercase` or `tracking-[…]` in any file this plan touches.
- Labels are sentence or title case, in Geist, `mute` colour (spec decision 4).
- No new hairline borders. Separate with space and tone (`sink`, `raise`) (decision 5).
- Header: 72px, no bottom border; wordmark + icon go to the Atrium; nav is Folio, Tasking, Gazetteer, then Contents ⌄; right side is Settings only (decision 7, §5.1).
- Footer: 34px `sink` band, sans 12.5px `mute`; left = sync + save state; right = screen context joined by ` · `; VESSEL, FILE/VIEW/CORPUS, uptime and UTC clock are removed (decision 12).
- Contents shortcut is ⌘⇧O. Theme toggle moves to ⌘⇧\\. ⌘⌥[ / ⌘⌥] toggle the left/right Folio sidebars, ⌘\\ toggles both, bare [ / ] toggle them outside the editor (§5.2, §9 Q5).
- G-then-letter jumps and header pinning stay deferred (§8).
- `routeViews.test` must still pass; every view keeps its `codexView` entry.
- Gates from `ui/`: `bun run typecheck`, `bun run lint`, `bun run test`. The full suite is diffed against the develop baseline of environmental Node 26 failures (about 903); only new failures count.
- Use Bun from `ui/` (`cd ui && bun run …`); `bun --cwd` does not work here.

## Review Focus

1. **⌘⌥[ and ⌘⇧\\ on a Mac keyboard.** ⌥ turns `[` into `“` and ⇧ turns `\` into `|` in `KeyboardEvent.key`. A person pressing the documented chord expects it to work. Pinned by the `code`-matching tests in Task 2.
2. **Several Folio tabs mounted at once.** The footer must show the *active* tab's path and word count, never an inactive tab's, and must clear when Folio unmounts. Pinned in Task 3.
3. **A failed save.** A mutation that errors must not produce "Saved …"; the footer keeps the last real save time. Pinned in Task 3.
4. **Feeds disabled.** Contents must not list Feeds and must not fire the feeds query. Pinned in Task 4.
5. **A user who had diegetic chrome off.** After upgrade the attribute and key are cleared and nothing stays hidden. Pinned in Task 6.
6. **Bare [ in the editor or on Tasking.** Typing `[` in the editor must type a bracket; on Tasking `[` must still toggle the Tasking rail, not the Folio sidebar. Pinned in Task 2.

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `ui/src/components/codex/viewRegistry.ts` | labels, `group`, `description`, `shortcut`, `CORE_NAV`, `contentsGroups()` | 1, 5 |
| `ui/src/lib/shortcuts.ts` | `Chord.code`, new ids, theme chord | 2 |
| `ui/src/store/folioRails.ts` (new) | collapsed state for Folio sidebars, persisted in the existing keys | 2 |
| `ui/src/components/codex/useCollapsibleRail.ts` | reads collapsed from `folioRails` | 2 |
| `ui/src/store/ui.ts` | `isContentsOpen`, `setContentsOpen`, `toggleContents` | 2 |
| `ui/src/hooks/useGlobalShortcuts.tsx` | bindings for the new ids | 2 |
| `ui/src/hooks/useSaveStatus.ts` (new) | `{ saving, savedAt }` from the mutation cache | 3 |
| `ui/src/store/footerContext.ts` (new) | owner-scoped footer parts + `useFooterContext` | 3 |
| `ui/src/components/codex/Folio.tsx` | publishes path + words when active | 3 |
| `ui/src/store/viewHistory.ts` (new) | recently visited non-core views | 4 |
| `ui/src/components/codex/ContentsMenu.tsx` (new) | the Contents trigger + sheet | 4 |
| `ui/src/components/SyncIndicator.tsx` | dot + word | 5 |
| `ui/src/components/codex/ShellFooter.tsx` (new) | footer contents | 5 |
| `ui/src/components/codex/DesktopCodexFrame.tsx` | header + footer composition | 5 |
| `ui/src/lib/theme.ts`, `ThemeProvider.tsx`, `SettingsModal.tsx`, `CommandPalette.tsx`, `commandRegistry.ts`, `public/theme-bootstrap.js`, docs inventory | diegetic removal | 6 |
| `ui/src/docs/content/configuration.mdx`, `getting-started.mdx` | docs for header, Contents, shortcuts | 2, 5, 6 |

---

### Task 1: Registry fields and CORE_NAV

**Files:**
- Modify: `ui/src/components/codex/viewRegistry.ts`
- Test: `ui/src/components/codex/viewRegistry.test.ts`

**Interfaces:**
- Produces:
  - `type ContentsGroup = "Write" | "Organise" | "Gather" | "Maintain" | "Reference"`
  - `CONTENTS_GROUPS: readonly ContentsGroup[]` (that order)
  - `ViewDescriptor.group: ContentsGroup | null`, `.description: string`, `.shortcut: ShortcutId | null`
  - `CORE_NAV: readonly CodexView[] = ["folio", "tasking", "gazetteer"]`
  - `contentsGroups(features: FeatureFlags): Array<{ group: ContentsGroup; views: CodexView[] }>` — views with `group !== null && go !== null`, feature-filtered, in registry order, empty groups dropped.
  - `isCoreView(view: CodexView): boolean` — `CORE_NAV.includes(VIEW_REGISTRY[view].navRoot)`.
- `DESKTOP_NAV` and `folioCode` stay until Task 5 so the old frame still compiles.

- [ ] **Step 1: Write the failing tests**

In `viewRegistry.test.ts`, replace the test `"preserves today's nav rail order and labels"` with the tests below, and add `CORE_NAV`, `CONTENTS_GROUPS`, `contentsGroups`, `isCoreView` to the import. Keep the mobile tests unchanged (mobile is phase 4b). The two `"removes … independently"` tests keep their `MOBILE_NAV` assertions; change their `DESKTOP_NAV` assertions to `contentsGroups` as shown.

```ts
describe("Stone & Lamp registry", () => {
  it("uses title-case labels", () => {
    expect(VIEW_REGISTRY.gazetteer.label).toBe("Gazetteer");
    expect(VIEW_REGISTRY.rubbish.label).toBe("Rubbish");
    for (const d of Object.values(VIEW_REGISTRY)) {
      expect(d.label).not.toMatch(/^[A-Z ]{2,}$/);
    }
  });

  it("puts exactly the core three in the header, in order", () => {
    expect(CORE_NAV).toEqual(["folio", "tasking", "gazetteer"]);
    expect(isCoreView("launcher")).toBe(true);
    expect(isCoreView("bases")).toBe(false);
    expect(isCoreView("repairs")).toBe(false);
  });

  it("groups every navigable non-home view for Contents", () => {
    const all = { academic: true, feeds: true };
    expect(CONTENTS_GROUPS).toEqual([
      "Write",
      "Organise",
      "Gather",
      "Maintain",
      "Reference",
    ]);
    expect(contentsGroups(all)).toEqual([
      { group: "Write", views: ["folio", "agenda"] },
      {
        group: "Organise",
        views: ["constellation", "gazetteer", "tasking", "bases"],
      },
      { group: "Gather", views: ["academic", "feeds"] },
      { group: "Maintain", views: ["stats", "rubbish", "repairs", "conflicts"] },
      { group: "Reference", views: ["docs"] },
    ]);
  });

  it("never lists home or non-navigable states in Contents", () => {
    const listed = contentsGroups({ academic: true, feeds: true }).flatMap(
      (g) => g.views,
    );
    expect(listed).not.toContain("atrium");
    expect(listed).not.toContain("launcher");
    expect(listed).not.toContain("archive");
  });

  it("gives every listed view a one-line description", () => {
    for (const { views } of contentsGroups({ academic: true, feeds: true })) {
      for (const v of views) {
        expect(VIEW_REGISTRY[v].description.length).toBeGreaterThan(0);
        expect(VIEW_REGISTRY[v].description).not.toContain("\n");
      }
    }
  });

  it("links registered shortcuts for hints", () => {
    expect(VIEW_REGISTRY.gazetteer.shortcut).toBe("nav.gazetteer");
    expect(VIEW_REGISTRY.tasking.shortcut).toBe("nav.tasking");
    expect(VIEW_REGISTRY.constellation.shortcut).toBe("nav.constellation");
    expect(VIEW_REGISTRY.bases.shortcut).toBeNull();
  });
});
```

In the Academic test replace the `DESKTOP_NAV` expectation with:

```ts
expect(
  contentsGroups(flags).flatMap((g) => g.views),
).not.toContain("academic");
```

and in the Feeds test with:

```ts
expect(contentsGroups(flags).flatMap((g) => g.views)).not.toContain("feeds");
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/components/codex/viewRegistry.test.ts`
Expected: FAIL — `CORE_NAV` / `contentsGroups` are not exported; labels are caps.

- [ ] **Step 3: Implement**

In `viewRegistry.ts`:

```ts
import type { ShortcutId } from "#/lib/shortcuts";

export type ContentsGroup =
  | "Write"
  | "Organise"
  | "Gather"
  | "Maintain"
  | "Reference";

export const CONTENTS_GROUPS: readonly ContentsGroup[] = [
  "Write",
  "Organise",
  "Gather",
  "Maintain",
  "Reference",
];
```

Add to `ViewDescriptor` (with doc comments in the file's style):

```ts
  /** Contents sheet group; null = not listed (home, transient states). */
  group: ContentsGroup | null;
  /** One line under the name in Contents. */
  description: string;
  /** Registered shortcut shown as a hint in Contents. */
  shortcut: ShortcutId | null;
```

Change each entry's `label` and add the three fields. Values (label / group / description / shortcut):

| view | label | group | description | shortcut |
|---|---|---|---|---|
| atrium | Atrium | null | Today at a glance. | `"nav.atrium"` |
| folio | Folio | Write | Pages, notes and journals, open as tabs. | null |
| launcher | Launcher | null | Open a page to start. | null |
| constellation | Constellation | Organise | The link graph. | `"nav.constellation"` |
| gazetteer | Gazetteer | Organise | Every page, filtered and sorted. | `"nav.gazetteer"` |
| stats | Stats | Maintain | Activity over time. | null |
| tasking | Tasking | Organise | Board, backlog, cycles and timeline. | `"nav.tasking"` |
| academic | Academic | Gather | DOI, ISBN and Zotero imports. | null |
| bases | Bases | Organise | Saved queries as tables and boards. | null |
| feeds | Feeds | Gather | Subscriptions and the river. | null |
| docs | Docs | Reference | How Clepsydra works. | null |
| archive | Archive | null | Web pages captured whole. | null |
| rubbish | Rubbish | Maintain | Binned pages, restorable. | null |
| repairs | Repairs | Maintain | Broken links, labels and codes. | null |
| agenda | Agenda | Write | Every open todo, across every page. | null |
| conflicts | Conflicts | Maintain | Sync copies waiting to be resolved. | null |

Registry order in the object literal stays as it is today (the `contentsGroups` expectations above follow it). Update the `label` doc comment to "Header/Contents text and screen name."

Add below `DESKTOP_NAV`:

```ts
/** Header nav: the core three. Everything else lives in Contents. */
export const CORE_NAV: readonly CodexView[] = ["folio", "tasking", "gazetteer"];

export function isCoreView(view: CodexView): boolean {
  const root = VIEW_REGISTRY[view].navRoot;
  return root !== null && CORE_NAV.includes(root);
}

export function contentsGroups(
  features: FeatureFlags,
): Array<{ group: ContentsGroup; views: CodexView[] }> {
  const views = enabledNavItems(
    (Object.keys(VIEW_REGISTRY) as CodexView[]).filter(
      (v) => VIEW_REGISTRY[v].group !== null && VIEW_REGISTRY[v].go !== null,
    ),
    features,
  );
  return CONTENTS_GROUPS.map((group) => ({
    group,
    views: views.filter((v) => VIEW_REGISTRY[v].group === group),
  })).filter((g) => g.views.length > 0);
}
```

- [ ] **Step 4: Run to verify pass, and check the frame tests still hold**

Run: `cd ui && bun run test src/components/codex/viewRegistry.test.ts src/components/codex/__tests__/CodexFrame.test.tsx src/routes`
Expected: registry tests PASS. CodexFrame tests use case-insensitive regexes (`/08.*DOCS/i`) and still PASS; if any asserts a caps label with an exact string, note it for Task 5 (do not change the frame here). `routeViews.test` PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/codex/viewRegistry.ts ui/src/components/codex/viewRegistry.test.ts
git commit -m "feat(ui): view registry gains Contents groups, descriptions and core nav"
```

---

### Task 2: Shortcuts — code matching, sidebars, theme, Contents

**Files:**
- Modify: `ui/src/lib/shortcuts.ts`, `ui/src/lib/shortcuts.test.ts`
- Create: `ui/src/store/folioRails.ts`, `ui/src/store/folioRails.test.ts`
- Modify: `ui/src/components/codex/useCollapsibleRail.ts`
- Modify: `ui/src/store/ui.ts`
- Modify: `ui/src/hooks/useGlobalShortcuts.tsx`, `ui/src/hooks/useGlobalShortcuts.test.tsx`
- Modify: `ui/src/components/codex/Folio.tsx` (rail storage keys → exported constants)
- Modify: `ui/src/docs/content/configuration.mdx` (theme shortcut text)

**Interfaces:**
- Produces:
  - `Chord.code?: string` — when set, `matchesChord` compares `e.code` instead of `e.key`, and shift is enforced strictly.
  - Shortcut ids: `"app.contents"` (⌘⇧O, Navigate, global), `"folio.toggleLeft"` (⌘⌥[), `"folio.toggleRight"` (⌘⌥]), `"folio.toggleBoth"` (⌘\\), `"folio.toggleLeftBare"` ([), `"folio.toggleRightBare"` (]) — all Workspace, global.
  - `"app.themeToggle"` chord → `{ key: "\\", code: "Backslash", mod: true, shift: true }`.
  - `FOLIO_LEFT_RAIL = "clp.folio.l"`, `FOLIO_RIGHT_RAIL = "clp.folio.r"` exported from `store/folioRails.ts`.
  - `useFolioRails` store: `collapsed: Record<string, boolean>`, `isCollapsed(key): boolean`, `setCollapsed(key, v)`, `toggle(key)`, `toggleBoth()`.
  - `useUiStore`: `isContentsOpen: boolean`, `setContentsOpen(open: boolean)`, `toggleContents()`.

- [ ] **Step 1: Write failing chord tests**

In `lib/shortcuts.test.ts`, extend `ev` to accept `code`:

```ts
function ev(key: string, mods: Mods = {}, code?: string) {
  return {
    key,
    code: code ?? "",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...mods,
  };
}
```

Add:

```ts
describe("code-matched chords (layout-shifted keys)", () => {
  it("matches ⌘⌥[ on a Mac, where ⌥ turns [ into “", () => {
    const chord = SHORTCUTS["folio.toggleLeft"].chord;
    const e = ev("“", { metaKey: true, altKey: true }, "BracketLeft");
    expect(matchesChord(e, chord, true)).toBe(true);
  });

  it("matches ⌘⇧\\ on a Mac, where ⇧ turns \\ into |", () => {
    const chord = SHORTCUTS["app.themeToggle"].chord;
    const e = ev("|", { metaKey: true, shiftKey: true }, "Backslash");
    expect(matchesChord(e, chord, true)).toBe(true);
  });

  it("keeps ⌘\\ (both sidebars) distinct from ⌘⇧\\ (theme)", () => {
    const both = SHORTCUTS["folio.toggleBoth"].chord;
    const theme = SHORTCUTS["app.themeToggle"].chord;
    const plain = ev("\\", { metaKey: true }, "Backslash");
    const shifted = ev("|", { metaKey: true, shiftKey: true }, "Backslash");
    expect(matchesChord(plain, both, true)).toBe(true);
    expect(matchesChord(plain, theme, true)).toBe(false);
    expect(matchesChord(shifted, both, true)).toBe(false);
  });

  it("formats code chords from their key", () => {
    expect(formatChord(SHORTCUTS["folio.toggleLeft"].chord, true)).toBe("⌥⌘[");
    expect(formatChord(SHORTCUTS["app.themeToggle"].chord, true)).toBe("⇧⌘\\");
  });

  it("registers ⌘⇧O for Contents without colliding with superscript", () => {
    const contents = SHORTCUTS["app.contents"].chord;
    expect(contents).toEqual({ key: "o", mod: true, shift: true });
    expect(
      matchesChord(ev(".", { metaKey: true }), contents, true),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/lib/shortcuts.test.ts`
Expected: FAIL — `folio.toggleLeft` / `app.contents` undefined (TypeScript-level undefined access at runtime → `Cannot read properties of undefined`).

- [ ] **Step 3: Implement registry + matcher**

In `lib/shortcuts.ts`:

- `Chord` gains:
  ```ts
  /** KeyboardEvent.code; when set it is matched instead of `key`, because
   *  ⌥ and ⇧ rewrite `key` on macOS (⌥[ → “, ⇧\ → |). `key` stays for
   *  display. */
  code?: string;
  ```
- `KeyLike` becomes `Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey"> & { code?: string }`.
- In `matchesChord`, replace the first three lines with:
  ```ts
  const want = chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;
  if (chord.code !== undefined) {
    if (e.code !== chord.code) return false;
  } else {
    const got = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    if (got !== want) return false;
  }
  ```
  and change the shift clause guard to `if (chord.code !== undefined || !isLetter || chord.shift !== undefined)`.
- `formatChord` glyph order stays as is (`⌥⇧⌘` then key), which gives `⌥⌘[` and `⇧⌘\`.
- Registry changes:
  ```ts
  "app.contents": {
    chord: { key: "o", mod: true, shift: true },
    label: "Contents",
    group: "Navigate",
    scope: "global",
  },
  ```
  (place after `"nav.tasking"`), and

  ```ts
  "app.themeToggle": {
    chord: { key: "\\", code: "Backslash", mod: true, shift: true },
    label: "Toggle dark / bone mode",
    group: "Workspace",
    scope: "global",
  },
  "folio.toggleLeft": {
    chord: { key: "[", code: "BracketLeft", mod: true, alt: true },
    label: "Toggle left sidebar",
    group: "Workspace",
    scope: "global",
    note: "folio",
  },
  "folio.toggleRight": {
    chord: { key: "]", code: "BracketRight", mod: true, alt: true },
    label: "Toggle right sidebar",
    group: "Workspace",
    scope: "global",
    note: "folio",
  },
  "folio.toggleBoth": {
    chord: { key: "\\", code: "Backslash", mod: true },
    label: "Toggle both sidebars (focus)",
    group: "Workspace",
    scope: "global",
    note: "folio",
  },
  "folio.toggleLeftBare": {
    chord: { key: "[" },
    label: "Toggle left sidebar",
    group: "Workspace",
    scope: "global",
    note: "folio, outside the editor",
  },
  "folio.toggleRightBare": {
    chord: { key: "]" },
    label: "Toggle right sidebar",
    group: "Workspace",
    scope: "global",
    note: "folio, outside the editor",
  },
  ```

- [ ] **Step 4: Run chord tests**

Run: `cd ui && bun run test src/lib/shortcuts.test.ts`
Expected: PASS (typecheck will fail until Step 8 adds bindings — that is expected mid-task).

- [ ] **Step 5: Write failing rail-store tests**

Create `ui/src/store/folioRails.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

let storage: Storage;
beforeEach(() => {
  storage = fakeStorage({ "clp.folio.l.collapsed": "1" });
  vi.stubGlobal("localStorage", storage);
  vi.resetModules();
});
afterEach(() => vi.unstubAllGlobals());

async function load() {
  return import("#/store/folioRails");
}

describe("folioRails", () => {
  it("reads the collapsed state users already have stored", async () => {
    const { useFolioRails, FOLIO_LEFT_RAIL, FOLIO_RIGHT_RAIL } = await load();
    expect(useFolioRails.getState().isCollapsed(FOLIO_LEFT_RAIL)).toBe(true);
    expect(useFolioRails.getState().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(false);
  });

  it("toggles one side and persists it in the existing key", async () => {
    const { useFolioRails, FOLIO_RIGHT_RAIL } = await load();
    useFolioRails.getState().toggle(FOLIO_RIGHT_RAIL);
    expect(useFolioRails.getState().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(true);
    expect(storage.getItem("clp.folio.r.collapsed")).toBe("1");
  });

  it("toggleBoth collapses both when either is open, else opens both", async () => {
    const { useFolioRails, FOLIO_LEFT_RAIL, FOLIO_RIGHT_RAIL } = await load();
    const s = () => useFolioRails.getState();
    s().toggleBoth(); // left collapsed, right open → collapse both
    expect(s().isCollapsed(FOLIO_LEFT_RAIL)).toBe(true);
    expect(s().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(true);
    s().toggleBoth(); // both collapsed → open both
    expect(s().isCollapsed(FOLIO_LEFT_RAIL)).toBe(false);
    expect(s().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(false);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `cd ui && bun run test src/store/folioRails.test.ts`
Expected: FAIL — module `#/store/folioRails` not found.

- [ ] **Step 7: Implement the rail store and wire the hook**

Create `ui/src/store/folioRails.ts`:

```ts
import { create } from "zustand";

/** Storage-key stems used by Folio's two sidebars (useCollapsibleRail
 *  appends `.collapsed` / `.w`). Kept identical to the pre-store keys so
 *  users keep their state. */
export const FOLIO_LEFT_RAIL = "clp.folio.l";
export const FOLIO_RIGHT_RAIL = "clp.folio.r";

const collapsedKey = (stem: string) => `${stem}.collapsed`;

function read(stem: string): boolean {
  try {
    return window.localStorage.getItem(collapsedKey(stem)) === "1";
  } catch {
    return false;
  }
}

function write(stem: string, v: boolean) {
  try {
    window.localStorage.setItem(collapsedKey(stem), v ? "1" : "0");
  } catch {
    // ignore
  }
}

interface FolioRailsState {
  collapsed: Record<string, boolean>;
  isCollapsed: (stem: string) => boolean;
  setCollapsed: (stem: string, v: boolean) => void;
  toggle: (stem: string) => void;
  toggleBoth: () => void;
}

/** Collapsed state for collapsible rails, shared so global shortcuts can
 *  drive Folio's sidebars. Width stays local to useCollapsibleRail. */
export const useFolioRails = create<FolioRailsState>((set, get) => ({
  collapsed: {},
  isCollapsed: (stem) => get().collapsed[stem] ?? read(stem),
  setCollapsed: (stem, v) => {
    write(stem, v);
    set((s) => ({ collapsed: { ...s.collapsed, [stem]: v } }));
  },
  toggle: (stem) => get().setCollapsed(stem, !get().isCollapsed(stem)),
  toggleBoth: () => {
    const { isCollapsed, setCollapsed } = get();
    const anyOpen =
      !isCollapsed(FOLIO_LEFT_RAIL) || !isCollapsed(FOLIO_RIGHT_RAIL);
    setCollapsed(FOLIO_LEFT_RAIL, anyOpen);
    setCollapsed(FOLIO_RIGHT_RAIL, anyOpen);
  },
}));
```

In `useCollapsibleRail.ts`: delete `readBool`, the `collapsed` `useState`, and the local `setCollapsed`/`toggle`. Replace with:

```ts
  const collapsed = useFolioRails(
    (s) => s.collapsed[storageKey] ?? s.isCollapsed(storageKey),
  );
  const setCollapsed = useCallback(
    (v: boolean) => useFolioRails.getState().setCollapsed(storageKey, v),
    [storageKey],
  );
  const toggle = useCallback(
    () => useFolioRails.getState().toggle(storageKey),
    [storageKey],
  );
```

Remove the now-unused `cKey`. The returned `Rail` shape is unchanged (many Folio tests mock it).

In `Folio.tsx` `DesktopFolioLayout`, replace the literal `storageKey: "clp.folio.l"` / `"clp.folio.r"` with `FOLIO_LEFT_RAIL` / `FOLIO_RIGHT_RAIL` imported from `#/store/folioRails`.

In `store/ui.ts` add to `UiState` and the store:

```ts
  isContentsOpen: boolean;
  setContentsOpen: (open: boolean) => void;
  toggleContents: () => void;
```
```ts
  isContentsOpen: false,
  setContentsOpen: (open) => set({ isContentsOpen: open }),
  toggleContents: () =>
    set((state) => ({ isContentsOpen: !state.isContentsOpen })),
```

- [ ] **Step 8: Write failing dispatcher tests**

In `hooks/useGlobalShortcuts.test.tsx`, reuse the file's existing `press` helper; extend it (if it does not already) to accept a `code` argument that is passed into the `KeyboardEvent` init. Add `mockCodexViewForPath` support for `/workspace` (already present). Add:

```ts
import { FOLIO_LEFT_RAIL, FOLIO_RIGHT_RAIL, useFolioRails } from "#/store/folioRails";

describe("Folio sidebar shortcuts", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/workspace");
    useFolioRails.setState({
      collapsed: { [FOLIO_LEFT_RAIL]: false, [FOLIO_RIGHT_RAIL]: false },
    });
  });

  it("⌘⌥[ toggles the left sidebar in the workspace", () => {
    renderHook(() => useGlobalShortcuts());
    press("“", { metaKey: true, altKey: true }, "BracketLeft");
    expect(useFolioRails.getState().isCollapsed(FOLIO_LEFT_RAIL)).toBe(true);
    expect(useFolioRails.getState().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(false);
  });

  it("⌘\\ collapses both", () => {
    renderHook(() => useGlobalShortcuts());
    press("\\", { metaKey: true }, "Backslash");
    expect(useFolioRails.getState().isCollapsed(FOLIO_LEFT_RAIL)).toBe(true);
    expect(useFolioRails.getState().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(true);
  });

  it("bare ] toggles the right sidebar outside the editor", () => {
    renderHook(() => useGlobalShortcuts());
    press("]", {}, "BracketRight");
    expect(useFolioRails.getState().isCollapsed(FOLIO_RIGHT_RAIL)).toBe(true);
  });

  it("bare [ types a bracket inside an editable target", () => {
    renderHook(() => useGlobalShortcuts());
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    document.body.append(editable);
    const e = new KeyboardEvent("keydown", {
      key: "[",
      code: "BracketLeft",
      bubbles: true,
      cancelable: true,
    });
    editable.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    expect(useFolioRails.getState().isCollapsed(FOLIO_LEFT_RAIL)).toBe(false);
    editable.remove();
  });

  it("bare [ on Tasking toggles the Tasking rail, not the Folio sidebar", () => {
    window.history.pushState({}, "", "/tasking");
    useBoardStore.setState({ railOpen: true });
    renderHook(() => useGlobalShortcuts());
    press("[", {}, "BracketLeft");
    expect(useBoardStore.getState().railOpen).toBe(false);
    expect(useFolioRails.getState().isCollapsed(FOLIO_LEFT_RAIL)).toBe(false);
  });
});

describe("theme and Contents shortcuts", () => {
  it("⌘⇧\\ toggles the theme; ⌘\\ no longer does", () => {
    window.history.pushState({}, "", "/workspace");
    renderHook(() => useGlobalShortcuts());
    press("\\", { metaKey: true }, "Backslash");
    expect(toggleThemeMock).not.toHaveBeenCalled();
    press("|", { metaKey: true, shiftKey: true }, "Backslash");
    expect(toggleThemeMock).toHaveBeenCalledTimes(1);
  });

  it("⌘⇧O toggles Contents, including while its dialog is open", () => {
    useUiStore.setState({ isContentsOpen: false });
    renderHook(() => useGlobalShortcuts());
    press("O", { metaKey: true, shiftKey: true }, "KeyO");
    expect(useUiStore.getState().isContentsOpen).toBe(true);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    press("O", { metaKey: true, shiftKey: true }, "KeyO");
    expect(useUiStore.getState().isContentsOpen).toBe(false);
    dialog.remove();
  });
});
```

(If `toggleThemeMock` is not reset between tests in this file, add `toggleThemeMock.mockClear()` at the start of the theme test.)

- [ ] **Step 9: Run to verify failure**

Run: `cd ui && bun run test src/hooks/useGlobalShortcuts.test.tsx`
Expected: FAIL — bindings missing (and `bun run typecheck` reports `bindings` is missing the new ids).

- [ ] **Step 10: Implement bindings**

In `useGlobalShortcuts.tsx`:

- import `FOLIO_LEFT_RAIL`, `FOLIO_RIGHT_RAIL`, `useFolioRails` from `#/store/folioRails`;
- `const toggleContents = useUiStore((s) => s.toggleContents);` and add it to the memo deps;
- add `"app.contents"` to `DIALOG_EXEMPT_IDS`;
- add bindings:

```ts
      "app.contents": { run: toggleContents },
      "folio.toggleLeft": {
        when: inWorkspace,
        run: () => useFolioRails.getState().toggle(FOLIO_LEFT_RAIL),
      },
      "folio.toggleRight": {
        when: inWorkspace,
        run: () => useFolioRails.getState().toggle(FOLIO_RIGHT_RAIL),
      },
      "folio.toggleBoth": {
        when: inWorkspace,
        run: () => useFolioRails.getState().toggleBoth(),
      },
      "folio.toggleLeftBare": {
        when: inWorkspace,
        run: () => useFolioRails.getState().toggle(FOLIO_LEFT_RAIL),
      },
      "folio.toggleRightBare": {
        when: inWorkspace,
        run: () => useFolioRails.getState().toggle(FOLIO_RIGHT_RAIL),
      },
```

The dispatcher loop needs no change: bare chords already skip editable targets, and a gated `[` on Tasking falls through to `tasking.toggleRail`, which is listed later — confirm the Tasking test passes; if the Folio bare binding is iterated first it is gated off by `inWorkspace`, so order does not matter.

- [ ] **Step 11: Docs**

In `ui/src/docs/content/configuration.mdx` § Theme toggle, replace the first sentence with: "Press **⌘⇧\\** (Ctrl+Shift+\\ elsewhere), run **Toggle dark mode**, or choose Dark/Paper under **Status → Appearance**." Leave the rest of the paragraph. (Task 5 removes the header-button mention if any remains.)

- [ ] **Step 12: Run task tests + typecheck**

Run: `cd ui && bun run test src/lib/shortcuts.test.ts src/store/folioRails.test.ts src/hooks/useGlobalShortcuts.test.tsx src/components/codex/__tests__/Folio.test.tsx src/docs && bun run typecheck`
Expected: PASS; typecheck 0.

- [ ] **Step 13: Commit**

```bash
git add ui/src/lib/shortcuts.ts ui/src/lib/shortcuts.test.ts ui/src/store/folioRails.ts ui/src/store/folioRails.test.ts ui/src/components/codex/useCollapsibleRail.ts ui/src/components/codex/Folio.tsx ui/src/store/ui.ts ui/src/hooks/useGlobalShortcuts.tsx ui/src/hooks/useGlobalShortcuts.test.tsx ui/src/docs/content/configuration.mdx
git commit -m "feat(ui): sidebar and Contents shortcuts; theme toggle moves to ⌘⇧\\"
```

---

### Task 3: Save status and footer context sources

**Files:**
- Create: `ui/src/hooks/useSaveStatus.ts`, `ui/src/hooks/useSaveStatus.test.tsx`
- Create: `ui/src/store/footerContext.ts`, `ui/src/store/footerContext.test.tsx`
- Modify: `ui/src/components/codex/Folio.tsx` (publish context)

**Interfaces:**
- Produces:
  - `useSaveStatus(): { saving: boolean; savedAt: number | null }` — `saving` = any mutation in flight; `savedAt` = `Date.now()` at the last *successful* mutation this session.
  - `useFooterContextStore` with `owner: string | null`, `parts: readonly string[]`, `publish(owner, parts)`, `clear(owner)`.
  - `useFooterContext(parts: readonly string[] | null): void` — publishes while mounted and `parts !== null`; clears on unmount or when `parts` becomes null, only if it still owns the slot.
  - `useFooterParts(): readonly string[]`.

- [ ] **Step 1: Write failing tests**

`ui/src/hooks/useSaveStatus.test.tsx`:

```tsx
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
} from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { useSaveStatus } from "#/hooks/useSaveStatus";

function setup() {
  const client = new QueryClient({
    defaultOptions: { mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => ({
      status: useSaveStatus(),
      ok: useMutation({ mutationFn: async () => "ok" }),
      bad: useMutation({
        mutationFn: async () => {
          throw new Error("nope");
        },
      }),
    }),
    { wrapper },
  );
}

describe("useSaveStatus", () => {
  it("starts idle with no save time", () => {
    const { result } = setup();
    expect(result.current.status).toEqual({ saving: false, savedAt: null });
  });

  it("records the time of a successful save", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    const { result } = setup();
    await act(() => result.current.ok.mutateAsync());
    await waitFor(() => expect(result.current.status.savedAt).toBe(1_000_000));
    expect(result.current.status.saving).toBe(false);
    vi.restoreAllMocks();
  });

  it("does not claim a save when the mutation fails", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.bad.mutateAsync().catch(() => undefined);
    });
    await waitFor(() => expect(result.current.status.saving).toBe(false));
    expect(result.current.status.savedAt).toBeNull();
  });
});
```

`ui/src/store/footerContext.test.tsx`:

```tsx
import { render, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  useFooterContext,
  useFooterContextStore,
  useFooterParts,
} from "#/store/footerContext";

function Publisher({ parts }: { parts: readonly string[] | null }) {
  useFooterContext(parts);
  return null;
}

beforeEach(() => useFooterContextStore.setState({ owner: null, parts: [] }));

describe("footer context", () => {
  it("shows what the mounted publisher sets and clears on unmount", () => {
    const { unmount } = render(<Publisher parts={["notes/a.md", "12 words"]} />);
    expect(renderHook(() => useFooterParts()).result.current).toEqual([
      "notes/a.md",
      "12 words",
    ]);
    unmount();
    expect(useFooterContextStore.getState().parts).toEqual([]);
  });

  it("an inactive publisher (null) never overwrites the active one", () => {
    render(
      <>
        <Publisher parts={["notes/active.md"]} />
        <Publisher parts={null} />
      </>,
    );
    expect(useFooterContextStore.getState().parts).toEqual(["notes/active.md"]);
  });

  it("a publisher that goes inactive releases the slot", () => {
    const { rerender } = render(<Publisher parts={["notes/a.md"]} />);
    rerender(<Publisher parts={null} />);
    expect(useFooterContextStore.getState().parts).toEqual([]);
  });

  it("an old owner's unmount does not clear a newer owner", () => {
    const a = render(<Publisher parts={["notes/a.md"]} />);
    render(<Publisher parts={["notes/b.md"]} />);
    a.unmount();
    expect(useFooterContextStore.getState().parts).toEqual(["notes/b.md"]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/hooks/useSaveStatus.test.tsx src/store/footerContext.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`ui/src/hooks/useSaveStatus.ts`:

```ts
import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** Footer save state: any vault write in flight, and when the last one
 *  succeeded this session. A failed write leaves `savedAt` untouched. */
export function useSaveStatus(): { saving: boolean; savedAt: number | null } {
  const client = useQueryClient();
  const saving = useIsMutating() > 0;
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(
    () =>
      client.getMutationCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success") {
          setSavedAt(Date.now());
        }
      }),
    [client],
  );
  return { saving, savedAt };
}
```

`ui/src/store/footerContext.ts`:

```ts
import { useEffect, useId } from "react";
import { create } from "zustand";

interface FooterContextState {
  owner: string | null;
  parts: readonly string[];
  publish: (owner: string, parts: readonly string[]) => void;
  clear: (owner: string) => void;
}

/** Right-hand footer context for the current screen (spec decision 12).
 *  One owner at a time; the shell appends its own defaults. */
export const useFooterContextStore = create<FooterContextState>((set, get) => ({
  owner: null,
  parts: [],
  publish: (owner, parts) => set({ owner, parts }),
  clear: (owner) => {
    if (get().owner === owner) set({ owner: null, parts: [] });
  },
}));

/** Publish `parts` while mounted; `null` means "not mine to show" (e.g. an
 *  inactive Folio tab) and releases the slot if held. */
export function useFooterContext(parts: readonly string[] | null): void {
  const owner = useId();
  const key = parts === null ? null : parts.join("\u0000");
  useEffect(() => {
    const { publish, clear } = useFooterContextStore.getState();
    if (key === null) {
      clear(owner);
      return;
    }
    publish(owner, key.split("\u0000"));
    return () => clear(owner);
  }, [owner, key]);
}

export function useFooterParts(): readonly string[] {
  return useFooterContextStore((s) => s.parts);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `cd ui && bun run test src/hooks/useSaveStatus.test.tsx src/store/footerContext.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Publish from Folio**

In `Folio.tsx`, inside `Folio` after the `wordCount` memo:

```ts
  const isActiveTab = useWorkspaceStore((s) => s.activeTabId === tabId);
  useFooterContext(
    isActiveTab
      ? [path, ...(wordCount > 0 ? [`${wordCount.toLocaleString()} words`] : [])]
      : null,
  );
```

Import `useFooterContext` from `#/store/footerContext`. (Check `Folio`'s props: `{ tabId, path }` at `Folio.tsx:260`.)

- [ ] **Step 6: Run the Folio suites**

Run: `cd ui && bun run test src/components/codex/__tests__/Folio.test.tsx src/components/codex/Folio.offline.test.tsx src/components/codex/__tests__/FolioNavigation.test.tsx`
Expected: same pass/fail set as on develop (diff the failure names against the baseline if any fail).

- [ ] **Step 7: Commit**

```bash
git add ui/src/hooks/useSaveStatus.ts ui/src/hooks/useSaveStatus.test.tsx ui/src/store/footerContext.ts ui/src/store/footerContext.test.tsx ui/src/components/codex/Folio.tsx
git commit -m "feat(ui): save status and footer context sources"
```

---

### Task 4: Contents sheet

**Files:**
- Create: `ui/src/store/viewHistory.ts`, `ui/src/store/viewHistory.test.ts`
- Create: `ui/src/components/codex/ContentsMenu.tsx`, `ui/src/components/codex/ContentsMenu.test.tsx`

**Interfaces:**
- Consumes: `contentsGroups`, `VIEW_REGISTRY`, `isCoreView`, `CORE_NAV` (Task 1); `useUiStore.isContentsOpen / setContentsOpen` (Task 2); `SHORTCUTS`, `formatChord`.
- Produces:
  - `useViewHistory` store: `recent: CodexView[]` (max 3, newest first, no duplicates), `record(view: CodexView)`; persisted under `clepsydra.recentViews`.
  - `ContentsMenu({ view, onGo, anchorRef }: { view: CodexView; onGo: (view: CodexView) => void; anchorRef: React.RefObject<HTMLElement | null> })` — renders the trigger button (accessible name "Contents") and the sheet. Trigger has `aria-current="page"` when `!isCoreView(view) && VIEW_REGISTRY[view].navRoot !== "atrium"`.

- [ ] **Step 1: Write failing tests**

`ui/src/store/viewHistory.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useViewHistory } from "#/store/viewHistory";

beforeEach(() => useViewHistory.setState({ recent: [] }));

describe("viewHistory", () => {
  it("keeps the three most recent non-core views, newest first", () => {
    const { record } = useViewHistory.getState();
    for (const v of ["bases", "feeds", "stats", "docs"] as const) record(v);
    expect(useViewHistory.getState().recent).toEqual(["docs", "stats", "feeds"]);
  });

  it("moves a revisited view to the front without duplicating it", () => {
    const { record } = useViewHistory.getState();
    record("bases");
    record("feeds");
    record("bases");
    expect(useViewHistory.getState().recent).toEqual(["bases", "feeds"]);
  });

  it("ignores core views, home and non-listed states", () => {
    const { record } = useViewHistory.getState();
    for (const v of ["folio", "tasking", "atrium", "launcher", "archive"] as const)
      record(v);
    expect(useViewHistory.getState().recent).toEqual([]);
  });
});
```

`ui/src/components/codex/ContentsMenu.test.tsx`:

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { flags, useFeedsMock, useConflictsMock } = vi.hoisted(() => ({
  flags: { academic: true, feeds: true },
  useFeedsMock: vi.fn(() => ({ data: { counts: { unread: 14 } } })),
  useConflictsMock: vi.fn(() => ({ data: { total: 2, items: [] } })),
}));

vi.mock("#/components/FeatureFlagsProvider", () => ({
  useFeatureFlags: () => flags,
}));
vi.mock("#/api/feeds", () => ({ useFeeds: useFeedsMock }));
vi.mock("#/api/index", () => ({ useSyncConflicts: useConflictsMock }));

import { ContentsMenu } from "#/components/codex/ContentsMenu";
import type { CodexView } from "#/components/codex/useCodexView";
import { useUiStore } from "#/store/ui";
import { useViewHistory } from "#/store/viewHistory";

function Harness({
  view = "atrium",
  onGo = vi.fn(),
}: {
  view?: CodexView;
  onGo?: (v: CodexView) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  return (
    <header ref={ref}>
      <ContentsMenu view={view} onGo={onGo} anchorRef={ref} />
    </header>
  );
}

beforeEach(() => {
  flags.academic = true;
  flags.feeds = true;
  useFeedsMock.mockClear();
  useUiStore.setState({ isContentsOpen: false });
  useViewHistory.setState({ recent: [] });
});

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Contents" }));
  return { user, sheet: await screen.findByRole("dialog", { name: "Contents" }) };
}

describe("ContentsMenu", () => {
  it("groups screens from the registry in five labelled sections", async () => {
    render(<Harness />);
    const { sheet } = await open();
    for (const g of ["Write", "Organise", "Gather", "Maintain", "Reference"]) {
      expect(within(sheet).getByRole("group", { name: g })).toBeVisible();
    }
    const organise = within(sheet).getByRole("group", { name: "Organise" });
    expect(
      within(organise).getAllByRole("option").map((o) => o.dataset.view),
    ).toEqual(["constellation", "gazetteer", "tasking", "bases"]);
  });

  it("marks the core three", async () => {
    render(<Harness />);
    const { sheet } = await open();
    const folio = within(sheet).getByRole("option", { name: /Folio/ });
    expect(within(folio).getByText("core")).toBeVisible();
    const bases = within(sheet).getByRole("option", { name: /Bases/ });
    expect(within(bases).queryByText("core")).toBeNull();
  });

  it("shows the unread and conflict badges", async () => {
    render(<Harness />);
    const { sheet } = await open();
    expect(
      within(within(sheet).getByRole("option", { name: /Feeds/ })).getByText("14"),
    ).toBeVisible();
    expect(
      within(within(sheet).getByRole("option", { name: /Conflicts/ })).getByText(
        "2",
      ),
    ).toBeVisible();
  });

  it("omits Feeds, and never asks for feed counts, when Feeds is off", async () => {
    flags.feeds = false;
    render(<Harness />);
    const { sheet } = await open();
    expect(within(sheet).queryByRole("option", { name: /Feeds/ })).toBeNull();
    expect(useFeedsMock).not.toHaveBeenCalled();
  });

  it("filters by name and goes with the keyboard", async () => {
    const onGo = vi.fn();
    render(<Harness onGo={onGo} />);
    const { user, sheet } = await open();
    await user.keyboard("bases");
    expect(within(sheet).getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onGo).toHaveBeenCalledWith("bases");
    expect(useUiStore.getState().isContentsOpen).toBe(false);
  });

  it("goes on click and closes", async () => {
    const onGo = vi.fn();
    render(<Harness onGo={onGo} />);
    const { user, sheet } = await open();
    await user.click(within(sheet).getByRole("option", { name: /Stats/ }));
    expect(onGo).toHaveBeenCalledWith("stats");
    expect(screen.queryByRole("dialog", { name: "Contents" })).toBeNull();
  });

  it("closes on Escape", async () => {
    render(<Harness />);
    const { user } = await open();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Contents" })).toBeNull();
  });

  it("lists recent screens that are still enabled", async () => {
    useViewHistory.setState({ recent: ["feeds", "bases"] });
    flags.feeds = false;
    render(<Harness />);
    const { sheet } = await open();
    const recent = within(sheet).getByRole("navigation", { name: "Recently" });
    expect(within(recent).getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Bases",
    ]);
  });

  it("takes the active dot on a non-core screen only", () => {
    const { rerender } = render(<Harness view="bases" />);
    expect(screen.getByRole("button", { name: "Contents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    rerender(<Harness view="folio" />);
    expect(
      screen.getByRole("button", { name: "Contents" }),
    ).not.toHaveAttribute("aria-current");
    rerender(<Harness view="atrium" />);
    expect(
      screen.getByRole("button", { name: "Contents" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("shows registered shortcut hints", async () => {
    render(<Harness />);
    const { sheet } = await open();
    const gaz = within(sheet).getByRole("option", { name: /Gazetteer/ });
    expect(gaz.textContent).toMatch(/I$/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/store/viewHistory.test.ts src/components/codex/ContentsMenu.test.tsx`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the history store**

`ui/src/store/viewHistory.ts`:

```ts
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { CodexView } from "#/components/codex/useCodexView";
import { isCoreView, VIEW_REGISTRY } from "#/components/codex/viewRegistry";

const MAX_RECENT = 3;

interface ViewHistoryState {
  recent: CodexView[];
  record: (view: CodexView) => void;
}

/** Recently visited Contents screens ("Recently: …" in the sheet). Core
 *  views live in the header, so they are not recorded. */
export const useViewHistory = create<ViewHistoryState>()(
  persist(
    (set) => ({
      recent: [],
      record: (view) => {
        const d = VIEW_REGISTRY[view];
        if (d.group === null || d.go === null || isCoreView(view)) return;
        set((s) => ({
          recent: [view, ...s.recent.filter((v) => v !== view)].slice(
            0,
            MAX_RECENT,
          ),
        }));
      },
    }),
    { name: "clepsydra.recentViews", partialize: (s) => ({ recent: s.recent }) },
  ),
);
```

- [ ] **Step 4: Implement ContentsMenu**

`ui/src/components/codex/ContentsMenu.tsx`:

```tsx
import { ChevronDown } from "lucide-react";
import {
  Autocomplete,
  Button,
  Dialog,
  DialogTrigger,
  Header,
  Input,
  ListBox,
  ListBoxItem,
  ListBoxSection,
  Popover,
  SearchField,
  useFilter,
} from "react-aria-components";
import { useFeeds } from "#/api/feeds";
import { useSyncConflicts } from "#/api/index";
import type { CodexView } from "#/components/codex/useCodexView";
import {
  contentsGroups,
  enabledNavItems,
  isCoreView,
  VIEW_REGISTRY,
} from "#/components/codex/viewRegistry";
import { useFeatureFlags } from "#/components/FeatureFlagsProvider";
import { cn } from "#/lib/cn";
import { formatChord, SHORTCUTS } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";
import { useViewHistory } from "#/store/viewHistory";

function FeedsBadge() {
  const unread = useFeeds().data?.counts.unread ?? 0;
  return unread > 0 ? <Badge>{unread}</Badge> : null;
}

function ConflictsBadge() {
  const total = useSyncConflicts().data?.total ?? 0;
  return total > 0 ? <Badge warn>{total}</Badge> : null;
}

function Badge({ children, warn }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-[11.5px] tabular-nums",
        warn ? "bg-warn/12 text-warn" : "bg-accent-tint text-accent",
      )}
    >
      {children}
    </span>
  );
}

function RowBadge({ view }: { view: CodexView }) {
  if (isCoreView(view)) return <Badge>core</Badge>;
  if (view === "feeds") return <FeedsBadge />;
  if (view === "conflicts") return <ConflictsBadge />;
  return null;
}

export function ContentsMenu({
  view,
  onGo,
  anchorRef,
}: {
  view: CodexView;
  onGo: (view: CodexView) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const features = useFeatureFlags();
  const isOpen = useUiStore((s) => s.isContentsOpen);
  const setOpen = useUiStore((s) => s.setContentsOpen);
  const recent = enabledNavItems(
    useViewHistory((s) => s.recent),
    features,
  );
  const { contains } = useFilter({ sensitivity: "base" });
  const active = !isCoreView(view) && VIEW_REGISTRY[view].navRoot !== "atrium";
  const groups = contentsGroups(features);

  const go = (target: CodexView) => {
    setOpen(false);
    onGo(target);
  };

  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <Button
        aria-current={active ? "page" : undefined}
        className={cn(
          "relative flex cursor-pointer items-center gap-1 text-[14px] outline-none",
          active ? "font-medium text-ink" : "text-mute hover:text-ink",
        )}
      >
        Contents
        <ChevronDown aria-hidden className="h-3.5 w-3.5" />
        {active && (
          <span
            aria-hidden
            className="absolute -bottom-2.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent"
          />
        )}
      </Button>
      <Popover
        triggerRef={anchorRef}
        placement="bottom"
        offset={0}
        className="w-[calc(100vw-48px)] rounded-[22px] bg-raise shadow-lg outline-none"
      >
        <Dialog aria-label="Contents" className="p-8 outline-none">
          <Autocomplete filter={contains}>
            <div className="mb-6 flex items-center gap-6">
              <SearchField aria-label="Filter screens" autoFocus className="flex-1">
                <Input
                  placeholder="Filter screens"
                  className="w-full rounded-full bg-sink px-4 py-2 text-[14px] text-ink outline-none placeholder:text-mute"
                />
              </SearchField>
              {recent.length > 0 && (
                <nav aria-label="Recently" className="flex items-center gap-2 text-[13px] text-mute">
                  <span>Recently:</span>
                  {recent.map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => go(v)}
                      className="cursor-pointer text-ink-2 hover:text-accent"
                    >
                      {VIEW_REGISTRY[v].label}
                    </button>
                  ))}
                </nav>
              )}
            </div>
            <ListBox
              aria-label="Screens"
              onAction={(key) => go(key as CodexView)}
              className="grid grid-cols-5 gap-8 outline-none"
            >
              {groups.map(({ group, views }) => (
                <ListBoxSection key={group} id={group} aria-label={group}>
                  <Header className="mb-3 font-serif text-[17px] italic text-mute">
                    {group}
                  </Header>
                  {views.map((v) => {
                    const d = VIEW_REGISTRY[v];
                    return (
                      <ListBoxItem
                        key={v}
                        id={v}
                        textValue={d.label}
                        data-view={v}
                        className={cn(
                          "mb-1 block cursor-pointer rounded-xl px-3 py-2 outline-none",
                          "data-[focused]:bg-sink data-[hovered]:bg-sink",
                          isCoreView(v) && "bg-accent-tint",
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <span className="text-[15px] font-medium text-ink">
                            {d.label}
                          </span>
                          <RowBadge view={v} />
                          <span className="flex-1" />
                          {d.shortcut && (
                            <kbd className="font-sans text-[12px] text-faint">
                              {formatChord(SHORTCUTS[d.shortcut].chord)}
                            </kbd>
                          )}
                        </span>
                        <span className="mt-0.5 block text-[12.5px] text-mute">
                          {d.description}
                        </span>
                      </ListBoxItem>
                    );
                  })}
                </ListBoxSection>
              ))}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
```

Notes for the implementer:
- `kbd` is covered by the code-mono rule in `main.css` (`:where(pre, code, kbd, samp)`); the explicit `font-sans` class wins because Tailwind utilities are layered *below* that unlayered rule — if the hint renders mono in the browser smoke, switch the element to `<span>` and keep `aria-hidden`. The test does not depend on the element name.
- `ListBoxSection` `aria-label` gives `role="group"` its name; if RAC 1.20 names the group from `Header` instead, keep both (the test queries by name).
- If `Autocomplete` does not narrow `ListBoxSection` children in RAC 1.20, filter manually: keep `const [q, setQ] = useState("")`, pass `value`/`onChange` to `SearchField`, and filter `views` with `contains(d.label, q)`; drop empty groups. The tests are the contract.
- Dimming: the frame (Task 5) draws the 26% ink scrim below the header while `isContentsOpen`.

- [ ] **Step 5: Run to verify pass**

Run: `cd ui && bun run test src/store/viewHistory.test.ts src/components/codex/ContentsMenu.test.tsx`
Expected: PASS (13 tests).

- [ ] **Step 6: Commit**

```bash
git add ui/src/store/viewHistory.ts ui/src/store/viewHistory.test.ts ui/src/components/codex/ContentsMenu.tsx ui/src/components/codex/ContentsMenu.test.tsx
git commit -m "feat(ui): Contents sheet grouped from the view registry"
```

---

### Task 5: Header and footer

**Files:**
- Modify: `ui/src/components/SyncIndicator.tsx`, `ui/src/components/SyncIndicator.test.tsx`
- Create: `ui/src/components/codex/ShellFooter.tsx`, `ui/src/components/codex/ShellFooter.test.tsx`
- Modify: `ui/src/components/codex/DesktopCodexFrame.tsx`
- Modify: `ui/src/components/codex/viewRegistry.ts` (delete `DESKTOP_NAV`, `folioCode`), `viewRegistry.test.ts`
- Modify: `ui/src/components/codex/__tests__/CodexFrame.test.tsx`
- Modify: `ui/src/docs/content/getting-started.mdx`, `configuration.mdx` (header description)

**Interfaces:**
- Consumes: Tasks 1–4 (`CORE_NAV`, `isCoreView`, `ContentsMenu`, `useSaveStatus`, `useFooterParts`, `useViewHistory.record`, `isContentsOpen`).
- Produces:
  - `SyncIndicator()` renders a dot plus one of: "Synced", "Connecting…", "Disconnected", "Offline since HH:MM", "Offline". `title` keeps the long `offlineLabel` text when offline.
  - `ShellFooter({ view }: { view: CodexView })`.

- [ ] **Step 1: Write failing SyncIndicator tests**

Replace the three tests in `SyncIndicator.test.tsx` with:

```tsx
  it("says Synced when connected", () => {
    render(<SyncIndicator />);
    expect(screen.getByText("Synced")).toBeVisible();
  });

  it("says when it went offline, with the copy time in the title", () => {
    useOnlineStatus.mockReturnValue(false);
    useConnectionStore.setState({ status: "disconnected", disconnectedSince: null });
    render(<SyncIndicator />);
    const time = new Date("2026-09-12T14:02:00Z").toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    expect(screen.getByText(`Offline since ${time}`)).toBeVisible();
    expect(
      screen.getByTitle(`Offline — vault as of ${time}`),
    ).toBeInTheDocument();
  });

  it("says Offline when there is no offline copy", () => {
    useOnlineStatus.mockReturnValue(false);
    useConnectionStore.setState({ status: "disconnected", disconnectedSince: null });
    useOfflineStore.setState({ lastFullSync: null });
    render(<SyncIndicator />);
    expect(screen.getByText("Offline")).toBeVisible();
    expect(screen.getByTitle("Offline — no offline copy")).toBeInTheDocument();
  });
```

(Keep the file's existing `beforeEach` that seeds `lastFullSync` to `2026-09-12T14:02:00Z` and `useOnlineStatus` → true.)

- [ ] **Step 2: Write failing ShellFooter tests**

`ui/src/components/codex/ShellFooter.test.tsx`:

```tsx
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { save } = vi.hoisted(() => ({
  save: { saving: false, savedAt: null as number | null },
}));

vi.mock("#/hooks/useSaveStatus", () => ({ useSaveStatus: () => save }));
vi.mock("#/components/SyncIndicator", () => ({
  SyncIndicator: () => <span>Synced</span>,
}));
vi.mock("#/api/index", () => ({
  useStats: () => ({
    data: { last_indexed_at: new Date(Date.now() - 60_000).toISOString() },
  }),
}));
vi.mock("#/components/codex/ReadingProgressContext", () => ({
  useReadingProgress: () => ({ progress: 0.42 }),
}));

import { ShellFooter } from "#/components/codex/ShellFooter";
import { useFooterContextStore } from "#/store/footerContext";

beforeEach(() => {
  save.saving = false;
  save.savedAt = null;
  useFooterContextStore.setState({ owner: null, parts: [] });
});

describe("ShellFooter", () => {
  it("shows sync state and nothing about saving before the first save", () => {
    render(<ShellFooter view="atrium" />);
    expect(screen.getByText("Synced")).toBeVisible();
    expect(screen.queryByText(/Sav/)).toBeNull();
  });

  it("shows Saving… while a write is in flight", () => {
    save.saving = true;
    render(<ShellFooter view="atrium" />);
    expect(screen.getByText("Saving…")).toBeVisible();
  });

  it("shows when the last save happened", () => {
    save.savedAt = Date.now() - 2 * 60_000;
    render(<ShellFooter view="atrium" />);
    expect(screen.getByText("Saved 2m ago")).toBeVisible();
  });

  it("defaults the right side to the index time", () => {
    render(<ShellFooter view="bases" />);
    expect(screen.getByText("Indexed 1m ago")).toBeVisible();
  });

  it("shows Folio's context, reading progress and index time, in order", () => {
    act(() =>
      useFooterContextStore.getState().publish("f", ["notes/a.md", "12 words"]),
    );
    render(<ShellFooter view="folio" />);
    expect(
      screen.getByText("notes/a.md · 12 words · 42% read · Indexed 1m ago"),
    ).toBeVisible();
  });

  it("never shows Vessel chrome", () => {
    render(<ShellFooter view="folio" />);
    const text = document.body.textContent ?? "";
    for (const gone of ["VESSEL", "FILE", "CORPUS", "UTC", "up "]) {
      expect(text).not.toContain(gone);
    }
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `cd ui && bun run test src/components/SyncIndicator.test.tsx src/components/codex/ShellFooter.test.tsx`
Expected: FAIL — "Synced" not found; `ShellFooter` module missing.

- [ ] **Step 4: Implement SyncIndicator and ShellFooter**

`SyncIndicator.tsx`: keep `offlineLabel` (exported, unchanged). Replace `STATUS_COLORS`, `labelFor` and the component:

```tsx
const DOT: Record<IndicatorStatus, string> = {
  connecting: "bg-faint animate-pulse",
  connected: "bg-accent",
  disconnected: "bg-hot",
  offline: "bg-faint",
};

function wordFor(status: IndicatorStatus, lastFullSync: string | null) {
  switch (status) {
    case "connecting":
      return "Connecting…";
    case "connected":
      return "Synced";
    case "disconnected":
      return "Disconnected";
    case "offline":
      if (!lastFullSync) return "Offline";
      return `Offline since ${new Date(lastFullSync).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })}`;
  }
}

export function SyncIndicator() {
  const sse = useConnectionStore((s) => s.status);
  const online = useOnlineStatus();
  const lastFullSync = useOfflineStore((s) => s.lastFullSync);
  const status: IndicatorStatus = online ? sse : "offline";
  const title = status === "offline" ? offlineLabel(lastFullSync) : undefined;

  return (
    <span className="flex items-center gap-1.5" title={title}>
      <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", DOT[status])} />
      <span>{wordFor(status, lastFullSync)}</span>
    </span>
  );
}
```

`ui/src/components/codex/ShellFooter.tsx`:

```tsx
import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useStats } from "#/api/index";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import type { CodexView } from "#/components/codex/useCodexView";
import { SyncIndicator } from "#/components/SyncIndicator";
import { useSaveStatus } from "#/hooks/useSaveStatus";
import { formatRelativeTime } from "#/lib/time";
import { useFooterParts } from "#/store/footerContext";

/** Re-render every 30s so relative times stay honest, scoped to the leaf so
 *  the shell does not re-render (CodexFrame test pins that). */
function useTick(ms = 30_000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function SaveState() {
  useTick();
  const { saving, savedAt } = useSaveStatus();
  if (saving)
    return (
      <span className="flex items-center gap-1.5">
        <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        Saving…
      </span>
    );
  if (savedAt === null) return null;
  return (
    <span className="flex items-center gap-1">
      <Check aria-hidden className="h-3 w-3" />
      {`Saved ${formatRelativeTime(new Date(savedAt).toISOString())}`}
    </span>
  );
}

function Context({ view }: { view: CodexView }) {
  useTick();
  const parts = useFooterParts();
  const { progress } = useReadingProgress();
  const { data: stats } = useStats();
  const all = [
    ...(view === "folio" ? parts : []),
    ...(view === "folio"
      ? [`${Math.round(Math.max(0, Math.min(1, progress)) * 100)}% read`]
      : []),
    ...(stats?.last_indexed_at
      ? [`Indexed ${formatRelativeTime(stats.last_indexed_at)}`]
      : []),
  ];
  return (
    <span className="min-w-0 truncate">{all.join(" · ")}</span>
  );
}

export function ShellFooter({ view }: { view: CodexView }) {
  return (
    <footer className="order-3 flex h-[34px] flex-shrink-0 items-center gap-5 bg-sink px-10 text-[12.5px] text-mute">
      <SyncIndicator />
      <SaveState />
      <span className="flex-1" />
      <Context view={view} />
    </footer>
  );
}
```

- [ ] **Step 5: Run to verify pass**

Run: `cd ui && bun run test src/components/SyncIndicator.test.tsx src/components/codex/ShellFooter.test.tsx`
Expected: PASS (9 tests).

- [ ] **Step 6: Rewrite the CodexFrame desktop tests (RED)**

In `CodexFrame.test.tsx`:

- In the `vi.mock("@tanstack/react-query")` factory add `useQueryClient: () => ({ getMutationCache: () => ({ subscribe: () => () => {} }) })`.
- Add mocks: `vi.mock("#/api/feeds", () => ({ useFeeds: () => ({ data: undefined }) }))`; in the `#/api/index` mock add `useSyncConflicts: () => ({ data: undefined })`.
- In the `#/store/ui` mock add `isContentsOpen: false`, `setContentsOpen: vi.fn()`, `toggleContents: vi.fn()` to the selector state.
- Delete these tests (their subject — numbered caps rail buttons for non-core screens and the FILE/VIEW footer — no longer exists): `"renders Docs as the active shell view for %s"`, `"keeps near-prefix Docs path %s in Atrium"`, `"navigates Docs to the typed default guide route"`, `"renders Stats as the active desktop destination after Gazetteer"`, `"navigates to Stats from the desktop rail"`, `"renders Feeds as a full-surface desktop destination before Docs"`, `"navigates to the Feeds index from the desktop rail"`, `"keeps Bases active for deep link %s"`, `"does not treat near-prefix path %s as Bases"`, `"navigates to the Bases index"`, `"marks Academic active and navigates to its library"`, `"shows the launcher state on /workspace with no active tab"`, `"retains the reading percentage for Folio"`, `"retains the desktop header and footer"`, `"hides disabled destinations and keeps desktop ordinals contiguous"`, `"keeps the desktop rail at tablet widths by scoping overflow to primary navigation"`. (Navigation *to* those screens is covered by `viewRegistry.test` `goToView` tests and `ContentsMenu.test`.)
- Add, inside `describe("CodexFrame destination integration")`:

```tsx
  const primary = () =>
    within(screen.getByRole("navigation", { name: "Primary navigation" }));

  it("shows exactly the core three plus Contents in the header", () => {
    locationState.pathname = "/";
    renderFrame();
    expect(primary().getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Folio",
      "Tasking",
      "Gazetteer",
      "Contents",
    ]);
  });

  it("goes home from the wordmark, which carries the dot on the Atrium", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();
    const mark = screen.getByRole("button", {
      name: "Clepsydra — Atrium (home)",
    });
    expect(mark).toHaveAttribute("aria-current", "page");
    locationState.pathname = "/gazetteer";
    await user.click(mark);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/" });
  });

  it.each([
    ["/gazetteer", "Gazetteer"],
    ["/tasking", "Tasking"],
    ["/workspace", "Folio"],
  ])("marks %s's core item current", (pathname, name) => {
    locationState.pathname = pathname;
    renderFrame();
    expect(primary().getByRole("button", { name })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(primary().getByRole("button", { name: "Contents" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it.each(["/bases/reading-log", "/feeds", "/docs/getting-started", "/repairs"])(
    "gives Contents the active dot on non-core %s",
    (pathname) => {
      locationState.pathname = pathname;
      renderFrame();
      expect(primary().getByRole("button", { name: "Contents" })).toHaveAttribute(
        "aria-current",
        "page",
      );
    },
  );

  it("keeps Settings on the right and drops search and theme buttons", async () => {
    const user = userEvent.setup();
    locationState.pathname = "/";
    renderFrame();
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(openSettingsMock).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /⌘K/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /dark mode|paper mode/i })).toBeNull();
  });

  it("renders the simplified footer", () => {
    locationState.pathname = "/";
    renderFrame();
    const footer = screen.getByRole("contentinfo");
    expect(footer).toHaveTextContent("Synced");
    expect(footer).not.toHaveTextContent(/VESSEL|FILE|CORPUS|UTC/);
  });
```

  Update the mobile test `"shows the seven roots and global actions in the mobile chrome"`: its `queryByText("TASKING")` line becomes `queryByText("Tasking")` still asserting absence in mobile chrome — keep the assertion that Tasking is not a mobile root (use `within(roots).queryByRole("button", { name: "Tasking" })` → null).

  The mock for `useVaultEvents` stays; `SyncIndicator` uses `useConnectionStore` and `useOnlineStatus` directly — if those are not mocked, "Synced" requires status `connected`; set `useConnectionStore.setState({ status: "connected" })` in `beforeEach` (import it from `#/offline/connectionStore`).

- [ ] **Step 7: Run to verify failure**

Run: `cd ui && bun run test src/components/codex/__tests__/CodexFrame.test.tsx`
Expected: FAIL — header still has numbered caps rail; no "Clepsydra — Atrium (home)" button.

- [ ] **Step 8: Rewrite DesktopCodexFrame**

Replace the component body. Delete `UptimeText`, `UtcClockText` and imports that become unused (`useUptime`, `useClock`, `formatClock`, `pad2`, `shortFolio`, `useStats`, `useIsMutating`, `offlineLabel`, `useConnectionStore`, `useOnlineStatus`, `useOfflineStore`, `useReadingProgress`, `useTheme`, `selectActiveTab`). The new component:

```tsx
export function DesktopCodexFrame({
  bottomSlot,
  forceView,
}: CodexFrameChromeProps) {
  const navigate = useNavigate();
  const openSettings = useUiStore((s) => s.openSettings);
  const contentsOpen = useUiStore((s) => s.isContentsOpen);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const openTab = useOpenTab();
  const activateTab = useActivateTabWithFolioHistory();
  const leaveWorkspace = useLeaveFolioWorkspace();
  const record = useViewHistory((s) => s.record);
  const headerRef = useRef<HTMLElement>(null);

  const resolved = useCodexView();
  const view = forceView ?? resolved;
  const descriptor = VIEW_REGISTRY[view];
  const go = (target: CodexView) =>
    goToView(target, { navigate, openTab, activateTab, leaveWorkspace });

  useEffect(() => record(view), [record, view]);

  return (
    <>
      <header
        ref={headerRef}
        className="order-0 flex h-[72px] min-w-0 flex-shrink-0 items-center gap-10 px-10"
      >
        <button
          type="button"
          onClick={() => go("atrium")}
          aria-label="Clepsydra — Atrium (home)"
          aria-current={descriptor.navRoot === "atrium" ? "page" : undefined}
          className="relative flex flex-shrink-0 cursor-pointer items-center gap-2.5"
        >
          <img
            src={`${import.meta.env.BASE_URL}favicon.svg`}
            alt=""
            className="h-7 w-7 rounded-[7px]"
          />
          <span className="font-serif text-[24px] leading-none text-ink">
            Clepsydra
          </span>
          {descriptor.navRoot === "atrium" && <ActiveDot />}
        </button>

        <nav
          aria-label="Primary navigation"
          className="flex min-w-0 items-center gap-7"
        >
          {CORE_NAV.map((key) => {
            const active = descriptor.navRoot === key;
            return (
              <button
                key={key}
                type="button"
                aria-current={active ? "page" : undefined}
                onClick={() => go(key)}
                className={cn(
                  "relative shrink-0 cursor-pointer text-[14px]",
                  active ? "font-medium text-ink" : "text-mute hover:text-ink",
                )}
              >
                {VIEW_REGISTRY[key].label}
                {active && <ActiveDot />}
              </button>
            );
          })}
          <ContentsMenu view={view} onGo={go} anchorRef={headerRef} />
        </nav>

        <div className="flex-1" />

        <button
          type="button"
          onClick={() => openSettings()}
          aria-label="Settings"
          className="flex h-9 w-9 cursor-pointer items-center justify-center rounded-full text-mute hover:bg-sink hover:text-ink"
        >
          <Settings aria-hidden className="h-[18px] w-[18px]" />
        </button>
      </header>

      {contentsOpen && (
        <div
          aria-hidden
          className="pointer-events-none fixed inset-x-0 bottom-0 top-[72px] z-40 bg-ink/26"
        />
      )}

      {descriptor.showsSheaf && (
        <Sheaf
          activeTabId={activeTabId}
          activeTabVisible={view === "folio"}
          className="order-1"
        />
      )}

      {bottomSlot ? createPortal(<ShellFooter view={view} />, bottomSlot) : null}
    </>
  );
}

function ActiveDot() {
  return (
    <span
      aria-hidden
      className="absolute -bottom-2.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-accent"
    />
  );
}
```

Imports to add: `useEffect`, `useRef` from react; `Settings` from `lucide-react`; `ContentsMenu`; `ShellFooter`; `CORE_NAV`; `useViewHistory`; `type CodexView`.

The Popover z-index must sit above the scrim (`z-40`); RAC popovers portal to `body` — give the Popover `z-50` in Task 4's className if the smoke shows it under the scrim.

Then in `viewRegistry.ts` delete `DESKTOP_NAV` and the `folioCode` field from the type and every entry, and delete the now-dead `DESKTOP_NAV` import/test lines in `viewRegistry.test.ts`.

- [ ] **Step 9: Docs**

`getting-started.mdx`: where it describes the header rail (numbered items / ⌘K button / [DARK] button), replace with: "The header holds the Clepsydra mark (home, the Atrium), the three core screens — **Folio**, **Tasking** and **Gazetteer** — and **Contents**, which lists every other screen by group (⌘⇧O). Settings sits on the right. The footer shows sync and save state on the left and details for the current screen on the right." Remove any sentence about the header theme button in `configuration.mdx`. Run `bun run test src/docs` — the mdx smoke tests check headings and keywords.

- [ ] **Step 10: Run task tests**

Run: `cd ui && bun run test src/components/codex src/components/SyncIndicator.test.tsx src/docs src/routes && bun run typecheck && bun run lint`
Expected: PASS for the new and rewritten tests; any other failures must be in the develop baseline list; typecheck 0; lint 0.

- [ ] **Step 11: Commit**

```bash
git add ui/src/components/SyncIndicator.tsx ui/src/components/SyncIndicator.test.tsx ui/src/components/codex/ShellFooter.tsx ui/src/components/codex/ShellFooter.test.tsx ui/src/components/codex/DesktopCodexFrame.tsx ui/src/components/codex/viewRegistry.ts ui/src/components/codex/viewRegistry.test.ts ui/src/components/codex/__tests__/CodexFrame.test.tsx ui/src/docs/content/getting-started.mdx ui/src/docs/content/configuration.mdx
git commit -m "feat(ui): Stone & Lamp header and simplified footer"
```

---

### Task 6: Remove the diegetic setting

**Files:**
- Modify: `ui/src/lib/theme.ts`, `ui/src/lib/__tests__/theme.test.ts`
- Modify: `ui/public/theme-bootstrap.js`, `ui/src/__tests__/themeBootstrap.test.ts`
- Modify: `ui/src/components/ThemeProvider.tsx`
- Modify: `ui/src/components/SettingsModal.tsx`, `ui/src/components/__tests__/SettingsModal.appearance.test.tsx`
- Modify: `ui/src/components/codex/CommandPalette.tsx`, `ui/src/components/codex/commandRegistry.ts`, `ui/src/components/codex/__tests__/CommandPalette.test.tsx`
- Modify: `ui/src/docs/featureInventory.ts`, `ui/src/docs/featureInventory.test.ts`, `ui/src/docs/registry.ts`, `ui/src/docs/content/configuration.mdx`
- Modify (mock cleanup only): `components/codex/__tests__/FolioNavigation.test.tsx`, `CodexFrameBreakpoint.integration.test.tsx`, `CodexFrame.test.tsx`

**Interfaces:**
- Produces: `clearLegacyDiegetic(): void` in `lib/theme.ts` — removes `data-diegetic` from `<html>` and the `clepsydra.diegetic` key; never throws. `ThemeContextValue` loses `diegetic` / `setDiegetic`.

- [ ] **Step 1: Write failing tests**

`lib/__tests__/theme.test.ts` — add at the bottom:

```ts
describe("clearLegacyDiegetic", () => {
  it("drops a pre-upgrade diegetic-off attribute and stored key", async () => {
    const storage = fakeStorage({ "clepsydra.diegetic": "off" });
    vi.stubGlobal("localStorage", storage);
    document.documentElement.setAttribute("data-diegetic", "off");
    const { clearLegacyDiegetic } = await import("#/lib/theme");
    clearLegacyDiegetic();
    expect(document.documentElement.hasAttribute("data-diegetic")).toBe(false);
    expect(storage.getItem("clepsydra.diegetic")).toBeNull();
  });

  it("does not throw when storage is unavailable", async () => {
    vi.stubGlobal("localStorage", undefined);
    const { clearLegacyDiegetic } = await import("#/lib/theme");
    expect(() => clearLegacyDiegetic()).not.toThrow();
  });
});
```

`__tests__/themeBootstrap.test.ts` — add:

```ts
  it("no longer hides chrome for a stored diegetic-off preference", () => {
    run({ "clepsydra.diegetic": "off" });
    expect(document.documentElement.hasAttribute("data-diegetic")).toBe(false);
  });
```

`SettingsModal.appearance.test.tsx` — add inside the `describe`:

```tsx
  it("has no diegetic chrome control", () => {
    render(<SettingsModal />);
    expect(screen.queryByText(/diegetic/i)).toBeNull();
  });
```

`CommandPalette.test.tsx` — add inside its main `describe` (same style as `"lists Today's journal and not Open Diurnal"`):

```tsx
  it("offers no diegetic chrome command", () => {
    render(<CommandPalette />);
    expect(screen.queryByText("Toggle diegetic chrome")).toBeNull();
  });
```

`commandRanking.test.ts` stays as it is: its "Toggle diegetic chrome" string is an arbitrary ranking fixture, not a registry reference.

- [ ] **Step 2: Run to verify failure**

Run: `cd ui && bun run test src/lib/__tests__/theme.test.ts src/__tests__/themeBootstrap.test.ts src/components/__tests__/SettingsModal.appearance.test.tsx src/components/codex/__tests__/CommandPalette.test.tsx`
Expected: FAIL — `clearLegacyDiegetic` not exported; bootstrap sets `data-diegetic`; Settings shows the row; the palette lists the command.

- [ ] **Step 3: Implement**

- `lib/theme.ts`: delete `DIEGETIC_STORAGE_KEY`, `DEFAULT_DIEGETIC`, `readStoredDiegetic`, `storeDiegetic`, `applyDiegetic`, and the diegetic part of the header comment. Add, beside `clearLegacyAccent`:

  ```ts
  /** Vessel's diegetic-chrome switch is gone (spec §4); drop any stored
   *  "off" so no stale attribute outlives the upgrade. */
  export function clearLegacyDiegetic(): void {
    document.documentElement.removeAttribute("data-diegetic");
    try {
      window.localStorage?.removeItem("clepsydra.diegetic");
    } catch {
      // storage unavailable — nothing to clear
    }
  }
  ```
- `public/theme-bootstrap.js`: delete the diegetic read and the `root.setAttribute("data-diegetic", "off")` branch.
- `ThemeProvider.tsx`: delete the `diegetic` state, `setDiegetic`, the `applyDiegetic` effect and the two context fields; in the existing mount effect call `clearLegacyDiegetic()` next to `clearLegacyAccent()`.
- `SettingsModal.tsx`: delete the "Diegetic chrome" `Row` and the `diegetic` / `setDiegetic` destructure.
- `commandRegistry.ts`: delete the `sys.chrome` entry and `"toggle-diegetic-chrome"` from the action union. `CommandPalette.tsx`: delete the `case "toggle-diegetic-chrome"` branch and `diegetic`/`setDiegetic` from `useTheme()` and the memo deps.
- `docs/featureInventory.ts`: delete the `sys.chrome` entry. `featureInventory.test.ts`: remove `"sys.chrome"` from `appearanceCommandIds` and delete its `it.each` row. `docs/registry.ts`: remove the `"diegetic chrome"` keyword. `configuration.mdx`: delete the `### Diegetic chrome` section and change "mode, density, and diegetic chrome" to "mode and density".
- Tests' `useTheme` mocks: delete `diegetic` / `setDiegetic` fields in `FolioNavigation.test.tsx`, `CodexFrameBreakpoint.integration.test.tsx`, `CodexFrame.test.tsx`, `CommandPalette.test.tsx`, `SettingsModal.appearance.test.tsx`.
- `viewRegistry.ts`: the `DESKTOP_NAV` comment mentioning diegetic is already gone (Task 5).

- [ ] **Step 4: Verify nothing references diegetic**

Run: `cd ui && rg -n -i "diegetic" src public --glob '!**/atrium-data*' --glob '!**/commandRanking.test.ts' --glob '!**/LocationModal.tsx'`
Expected: no output. (`atrium-data.ts`, `LocationModal.tsx` and the ranking fixture use "diegetic" as a descriptive word; leave them.)

- [ ] **Step 5: Run task tests + gates**

Run: `cd ui && bun run test src/lib src/__tests__ src/components/__tests__/SettingsModal.appearance.test.tsx src/components/codex src/docs && bun run typecheck && bun run lint`
Expected: PASS apart from baseline failures; typecheck 0; lint 0.

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/theme.ts ui/src/lib/__tests__/theme.test.ts ui/public/theme-bootstrap.js ui/src/__tests__/themeBootstrap.test.ts ui/src/components/ThemeProvider.tsx ui/src/components/SettingsModal.tsx ui/src/components/__tests__/SettingsModal.appearance.test.tsx ui/src/components/codex/CommandPalette.tsx ui/src/components/codex/commandRegistry.ts ui/src/components/codex/__tests__/CommandPalette.test.tsx ui/src/docs/featureInventory.ts ui/src/docs/featureInventory.test.ts ui/src/docs/registry.ts ui/src/docs/content/configuration.mdx ui/src/components/codex/__tests__/FolioNavigation.test.tsx ui/src/components/codex/__tests__/CodexFrameBreakpoint.integration.test.tsx ui/src/components/codex/__tests__/CodexFrame.test.tsx
git commit -m "feat(ui): remove the diegetic chrome setting"
```

---

### Task 7: Gates, smoke, docs, merge

**Files:**
- Modify: `ui/CLAUDE.md` (Design Aesthetic: note phase 2a done), spec status line
- No production code unless the smoke finds a defect (then RED→GREEN with a test first)

- [ ] **Step 1: Full gates**

Run from `ui/`:
```bash
bun run typecheck && bun run lint && bun run test > "$WS/full.txt" 2>&1; grep -E "Tests |Test Files" "$WS/full.txt"
grep "^ FAIL " "$WS/full.txt" | sort -u > "$WS/after.txt"
```
Diff `after.txt` against the develop baseline captured at branch start (`git stash`-free: run the suite on develop in the main checkout before starting Task 1 and save its `FAIL` list as `$WS/base.txt`). Expected: no line in `after.txt` that is not in `base.txt`. Any new failure gets a ruling or a fix.

- [ ] **Step 2: Browser smoke (Playwright plugin)**

Scratch vault only — set `CLEPSYDRA__VAULT__ROOT` and run from a directory with a local `config.toml` (never the live vault). Start `clep serve` on a free port and `bun run dev` with `CLEPSYDRA_API_TARGET`. Check, in bone and charcoal:
- header: mark goes home and carries the dot on the Atrium; Folio / Tasking / Gazetteer switch and carry the dot; Settings opens.
- Contents: click and ⌘⇧O open it; scrim dims below the header; filter narrows; ↓ + Enter goes; Esc closes; "Recently" appears after visiting Bases; Conflicts/Feeds badges render when counts exist.
- footer: "Synced"; edit a page → "Saving…" then "Saved just now"; Folio shows path · words · % read · Indexed; Gazetteer shows only "Indexed …".
- shortcuts: ⌘⌥[ / ⌘⌥] / ⌘\\ / [ / ] toggle Folio sidebars (and [ types in the editor); ⌘⇧\\ toggles theme; ⌘/ help lists the new entries.
- a stored `clepsydra.diegetic = "off"` is cleared on load.
Save screenshots in the scratchpad.

- [ ] **Step 3: Docs**

`ui/CLAUDE.md` Design Aesthetic first paragraph: "Phase 1 (tokens + fonts) and phase 2a (header, Contents, footer) are done; the Sheaf (2b) and layouts are still Vessel until phases 2b–5 land." Spec status line: add "Phase 1 and 2a built."

- [ ] **Step 4: Commit and merge**

```bash
git add ui/CLAUDE.md docs/superpowers/specs/2026-09-25-stone-and-lamp-redesign-design.md
git commit -m "docs: Stone & Lamp phase 2a shell is built"
```
Merging into `develop` follows superpowers:finishing-a-development-branch (confirm with the user; audit `git log <branch>..develop` for other sessions' commits first).

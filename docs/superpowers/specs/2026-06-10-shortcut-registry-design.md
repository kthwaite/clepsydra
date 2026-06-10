# Centralised Shortcut Registry & Help Modal

**Date:** 2026-06-10
**Status:** Design approved, pending implementation

---

## 1) Background

Keyboard handling is currently distributed across ~10 sites with no single
source of truth:

- Global `window` listeners: `CommandPalette.tsx` (⌘K), `CodexFrame.tsx` (⌘N),
  `Folio.tsx` (⌘S), `workspace.tsx` (⌘W, Ctrl+Tab, Ctrl+Shift+Tab),
  `BootSequence.tsx` (Escape).
- Editor bindings inside `SlateEditor.tsx` `handleKeyDown`: Tab/Shift+Tab
  (indent/outdent), Alt+↑/↓ (move block), ⌘Enter (checkbox), ⌘S (save),
  ⌘B/I/U/E/D (marks), ⌘. / ⌘, (super/subscript).
- Key labels are hard-coded separately from handlers (`<kbd>` elements,
  palette verb-command `id` hints).

**Drift has already happened:** the command palette advertises ⌘H, ⌘D, ⌘G,
⌘I, ⌘`,` and ⌘\ as key hints for its verb commands, but none of these are
bound anywhere. Two of them also collide with real editor marks (⌘D
strikethrough, ⌘, subscript). Hard-coded `⌘` glyphs additionally render
wrong on non-Mac platforms.

## 2) Scope

### In scope
- A typed shortcut registry as the single source of truth for key chords,
  labels, grouping, and scope.
- A single global dispatcher hook replacing the scattered global listeners.
- Binding the six phantom palette shortcuts for real (⌘H, ⌘D, ⌘G, ⌘I, ⌘`,`,
  ⌘\), with a defined conflict policy against editor marks.
- A Vessel-styled help modal listing shortcuts, derived entirely from the
  registry, opened via ⌘/ and a palette entry.
- Palette key hints and editor chord-matching read from the registry.
- Platform-aware chord display (⌘K on Mac, Ctrl+K elsewhere).

### Explicitly out of scope
- Widget-internal navigation keys (combobox/palette ↑ ↓ ⏎, tag-input
  Backspace/comma behaviour, suggestion-popover keys). These remain local
  `onKeyDown` handlers and are not registry entries.
- Refactoring `SlateEditor.tsx` dispatch flow. The editor keeps its
  `handleKeyDown` structure; only chord *matching* moves to the registry.
- User-customisable rebinding. The registry is static data; its shape should
  not preclude rebinding later, but no persistence/config UI is built now.
- New keyboard libraries. Everything stays hand-rolled (no tinykeys etc.).

## 3) Registry — `ui/src/lib/shortcuts.ts`

```ts
export type Chord = {
  /** KeyboardEvent.key, lowercase for letters (e.g. "k", "tab", "enter", "/") */
  key: string;
  /** ⌘ on Mac, Ctrl elsewhere (matches metaKey || ctrlKey) */
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ShortcutGroup = "Navigate" | "Workspace" | "Editor";

export type ShortcutDef = {
  id: ShortcutId;
  chord: Chord;
  /** Help-modal row label, e.g. "Open command console" */
  label: string;
  group: ShortcutGroup;
  /** Who dispatches: "global" → useGlobalShortcuts; "editor" → SlateEditor;
   *  "contextual" → a component-local listener (e.g. Folio ⌘S) */
  scope: "global" | "editor" | "contextual";
  /** Dimmed annotation in the help modal, e.g. "outside the editor" */
  note?: string;
};

export const SHORTCUTS: Record<ShortcutId, ShortcutDef> = { /* ... */ };
```

`ShortcutId` is a string-literal union so the dispatcher's handler map can be
checked for exhaustiveness at compile time.

### Registry contents

| id | chord | group | scope | note |
|---|---|---|---|---|
| `palette.toggle` | mod+K | Navigate | global | |
| `nav.atrium` | mod+H | Navigate | global | |
| `nav.diurnal` | mod+D | Navigate | global | outside the editor |
| `nav.constellation` | mod+G | Navigate | global | |
| `nav.gazetteer` | mod+I | Navigate | global | outside the editor |
| `app.inscribe` | mod+N | Workspace | global | |
| `app.settings` | mod+, | Workspace | global | outside the editor |
| `app.themeToggle` | mod+\ | Workspace | global | |
| `app.shortcutHelp` | mod+/ | Workspace | global | |
| `tabs.close` | mod+W | Workspace | global | workspace view |
| `tabs.next` | Ctrl+Tab | Workspace | global | workspace view |
| `tabs.prev` | Ctrl+Shift+Tab | Workspace | global | workspace view |
| `folio.save` | mod+S | Workspace | contextual¹ | with a folio open |
| `editor.indent` | Tab | Editor | editor | |
| `editor.outdent` | Shift+Tab | Editor | editor | |
| `editor.moveUp` | Alt+↑ | Editor | editor | |
| `editor.moveDown` | Alt+↓ | Editor | editor | |
| `editor.checkbox` | mod+Enter | Editor | editor | |
| `editor.mark.bold` | mod+B | Editor | editor | |
| `editor.mark.italic` | mod+I | Editor | editor | |
| `editor.mark.underline` | mod+U | Editor | editor | |
| `editor.mark.code` | mod+E | Editor | editor | |
| `editor.mark.strikethrough` | mod+D | Editor | editor | |
| `editor.mark.superscript` | mod+. | Editor | editor | |
| `editor.mark.subscript` | mod+, | Editor | editor | |

¹ `folio.save` has `scope: "contextual"`: it is listed in the help modal but
its listener stays in `Folio.tsx` (the save action lives in the page's
closure); see §5. `GlobalShortcutId` — the key type of the dispatcher's
exhaustive handler map — is derived from `scope: "global"` entries only, so
contextual entries demand no dispatcher handler. ⌘S appears once in the help
modal even though both Folio and the editor honour it; the editor's ⌘S
branch is *not* a separate registry entry.

`nav.gazetteer` (mod+I) collides with `editor.mark.italic` exactly like
mod+D and mod+, — resolved by the same conflict policy (§4); hence its
"outside the editor" note.

### Helpers

```ts
/** The one chord-matching predicate, used by dispatcher, editor, Folio. */
export function matchesChord(e: KeyboardEvent | React.KeyboardEvent, chord: Chord): boolean;

/** Platform-aware display: "⌘K" on Mac, "Ctrl+K" elsewhere; "⇧", "⌥"/"Alt",
 *  arrows, "⏎" handled. */
export function formatChord(chord: Chord): string;

/** All defs in stable help-modal order, grouped. */
export function shortcutsByGroup(): Array<[ShortcutGroup, ShortcutDef[]]>;
```

`matchesChord` semantics:
- `mod: true` ⇔ `e.metaKey || e.ctrlKey` (and `mod: false`/absent ⇔ neither),
  **except** for chords where `key === "tab"` with explicit Ctrl semantics —
  `tabs.next`/`tabs.prev` use Ctrl specifically (current behaviour). To keep
  the model honest, `Chord` gains an optional `ctrl?: boolean` for the two
  Ctrl-Tab entries; `mod` and `ctrl` are mutually exclusive in practice.
- Letter keys compare case-insensitively (`e.key.toLowerCase()`), so ⇧ as a
  side effect of the letter doesn't break matching; `shift` is only enforced
  when the chord declares it or the key is non-letter.
- Platform detection via `navigator.platform`/`userAgentData` once at module
  load, exported as `IS_MAC` for `formatChord`.

## 4) Global dispatcher — `ui/src/hooks/useGlobalShortcuts.ts`

A single `window.addEventListener("keydown", …)` mounted **once** in
`CodexFrame`. Behaviour:

1. **Yield to consumers:** return immediately if `e.defaultPrevented`. The
   Slate editor's React `onKeyDown` runs before the window bubble listener
   and calls `preventDefault()` on every chord it handles, so inside the
   editor ⌘D = strikethrough, ⌘I = italic, ⌘, = subscript, and the global
   nav/settings bindings simply never fire. Outside the editor the global
   bindings win. This is the entire conflict policy — no focus sniffing.
2. Walk global-scope bindings; for the first `matchesChord` hit whose `when`
   predicate (if any) passes, `preventDefault()` and invoke its handler.
3. `when` predicates preserve current behaviour: `tabs.close`, `tabs.next`,
   `tabs.prev` only act when the current location is under `/workspace`
   (today they're bound in the workspace route component).

Handler wiring: `useGlobalShortcuts()` builds a
`Record<GlobalShortcutId, () => void>` from hooks available in `CodexFrame`
(`useNavigate`, `useUiStore`, `useWorkspaceStore.getState()` for tab ops,
`useTheme`, `useOpenTab` for the graph tab). Missing an entry is a compile
error.

New real bindings (previously phantom):
- mod+H → navigate `/`
- mod+D → navigate `/journal`
- mod+G → open graph tab (+ navigate `/workspace`)
- mod+I → navigate `/gazetteer`
- mod+, → `openSettings("appearance")`
- mod+\ → theme toggle
- mod+/ → open shortcut help modal

**Removed listeners** (absorbed by the dispatcher):
- `CommandPalette.tsx:58-67` (⌘K)
- `CodexFrame.tsx:81-90` (⌘N)
- `workspace.tsx:14-36` (⌘W, Ctrl+Tab, Ctrl+Shift+Tab)

Known platform caveat (unchanged from today): browsers may reserve mod+W and
Ctrl+Tab at the chrome level; where the browser refuses to deliver them, the
binding silently can't fire. Not our bug; noted here so nobody "fixes" it.

## 5) Contextual listeners that remain in place

- **`Folio.tsx` ⌘S** — keeps its own window listener (the save closure lives
  there) but matches via `matchesChord(e, SHORTCUTS["folio.save"].chord)`.
- **`SlateEditor.tsx`** — `handleKeyDown` keeps its exact structure and
  ordering (combobox passthrough first, then outliner, save, marks), but
  every chord test becomes `matchesChord(event, SHORTCUTS["editor.…"].chord)`.
  No behavioural change intended.
- **`BootSequence.tsx` Escape** — untouched and not a registry entry
  (transient splash affordance, already labelled on screen).

## 6) Help modal — `ui/src/components/codex/ShortcutHelpModal.tsx`

- **State:** `isShortcutHelpOpen` + `openShortcutHelp`/`closeShortcutHelp`
  on `useUiStore`, following the existing settings/inscribe pattern.
  Mounted in the frame next to `CommandPalette`/`InscribeModal`.
- **Open via:** `app.shortcutHelp` (mod+/) in the dispatcher, and a new
  palette verb command ("Keyboard shortcuts", key hint from `formatChord`).
- **Content:** rendered from `shortcutsByGroup()` — three columns/sections
  (NAVIGATE / WORKSPACE / EDITOR), each row: `label`, keycap-styled
  `formatChord(chord)`, dimmed `note` when present. Adding a registry entry
  automatically lists it; there is no second list to maintain.
- **Styling:** Vessel chrome matching `CommandPalette` — fixed overlay with
  `bg-black/35` backdrop, hard-edged `border-[1.5px] border-ink bg-paper`
  panel, `cl-mono` section headers with tracking, keycaps as bordered spans
  (`border border-ink/40 px-[6px]`) like the palette footer legend. Zero
  radius, token colours only.
- **Dismiss:** Escape and backdrop mouse-down, same as the palette
  (`role="dialog"`, `aria-label="Keyboard shortcuts"`).

## 7) Palette de-drift

`CommandPalette.tsx` verb commands take their key-hint `id` column from
`formatChord(SHORTCUTS[…].chord)` instead of hard-coded strings. Commands
without a chord (`sys.chrome`, `sys.boot`) keep their machine-id hints. The
palette can no longer advertise an unbound key, and hints become
platform-correct for free.

## 8) Testing

- **`shortcuts.test.ts`:** `matchesChord` across mod/ctrl/shift/alt
  combinations, letter case-insensitivity, Tab/Enter/arrow keys, and
  `defaultPrevented`-style non-matches; `formatChord` for Mac and non-Mac
  (mock `IS_MAC`).
- **Exhaustiveness:** the dispatcher's handler map is typed
  `Record<GlobalShortcutId, () => void>` — adding a global registry entry
  without a handler fails `bun run typecheck`.
- **`useGlobalShortcuts` tests:** ⌘K toggles palette state, ⌘N opens
  inscribe, ⌘H/⌘D/⌘G/⌘I navigate, ⌘D is ignored when a prior handler called
  `preventDefault()` (conflict policy), tab shortcuts gated by the
  `/workspace` `when` predicate.
- **`ShortcutHelpModal` test:** renders every registry entry exactly once
  under its group; Escape closes.
- **Parity regression:** existing workspace-route tab-cycling behaviour
  (close active tab, wrap-around next/prev) re-asserted against the new
  dispatcher.

## 9) Files

| File | Change |
|---|---|
| `ui/src/lib/shortcuts.ts` | new — registry, `matchesChord`, `formatChord`, `shortcutsByGroup` |
| `ui/src/lib/shortcuts.test.ts` | new |
| `ui/src/hooks/useGlobalShortcuts.ts` | new — dispatcher + handler map |
| `ui/src/components/codex/ShortcutHelpModal.tsx` | new |
| `ui/src/store/ui.ts` | add shortcut-help open state |
| `ui/src/components/codex/CodexFrame.tsx` | mount dispatcher + modal; delete ⌘N listener |
| `ui/src/components/codex/CommandPalette.tsx` | delete ⌘K listener; hints from registry; add help command |
| `ui/src/routes/workspace.tsx` | delete keydown effect (absorbed) |
| `ui/src/components/codex/Folio.tsx` | match ⌘S via registry chord |
| `ui/src/editor/SlateEditor.tsx` | match chords via registry; no flow change |

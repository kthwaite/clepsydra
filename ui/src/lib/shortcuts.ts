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
  /** ⌘ on Mac, Ctrl elsewhere. Strict: the other platform's modifier never
   *  matches, so macOS Ctrl-E etc. keep their system cursor-motion behavior. */
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
  "journal.today": {
    chord: { key: "d", mod: true, shift: false },
    label: "Today's journal",
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
  "nav.tasking": {
    chord: { key: "j", mod: true },
    label: "Open Tasking",
    group: "Navigate",
    scope: "global",
  },
  "app.inscribe": {
    chord: { key: "n", mod: true },
    label: "Inscribe new folio",
    group: "Workspace",
    scope: "global",
  },
  "journal.capture": {
    chord: { key: "d", mod: true, shift: true },
    label: "Capture aside",
    group: "Workspace",
    scope: "global",
    note: "appends to today's journal",
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
  "editor.vimMode": {
    chord: { key: "v", mod: true, shift: true },
    label: "Toggle vim mode",
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
export function matchesChord(
  e: KeyLike,
  chord: Chord,
  isMac: boolean = IS_MAC,
): boolean {
  const want = chord.key.length === 1 ? chord.key.toLowerCase() : chord.key;
  const got = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (got !== want) return false;

  if (chord.ctrl) {
    if (!e.ctrlKey || e.metaKey) return false;
  } else {
    const [mod, other] = isMac
      ? [e.metaKey, e.ctrlKey]
      : [e.ctrlKey, e.metaKey];
    if ((chord.mod ?? false) !== mod || other) return false;
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

/**
 * VimKey: the parser's input token.
 *
 * Printable characters are the literal character with shift already folded
 * in by the browser ("a", "A", "$", "0", '"'). Named keys use vim's angle
 * bracket notation: "<Esc>", "<CR>", "<Left>", "<C-r>", ...
 */
export type VimKey = string;

interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

const NAMED_KEYS: Record<string, VimKey> = {
  Escape: "<Esc>",
  Enter: "<CR>",
  Backspace: "<BS>",
  ArrowLeft: "<Left>",
  ArrowRight: "<Right>",
  ArrowUp: "<Up>",
  ArrowDown: "<Down>",
};

/** Ctrl chords vim mode claims; everything else falls through to the app. */
const CLAIMED_CTRL_KEYS = new Set(["r"]);

/**
 * Normalize a keyboard event into a VimKey, or `null` when the key is not
 * vim-relevant (bare modifiers, unclaimed ctrl/meta/alt chords) and should
 * fall through to the app's own shortcut handling.
 */
export function tokenize(event: KeyEventLike): VimKey | null {
  if (event.metaKey || event.altKey) return null;
  if (event.ctrlKey) {
    return CLAIMED_CTRL_KEYS.has(event.key) ? `<C-${event.key}>` : null;
  }
  const named = NAMED_KEYS[event.key];
  if (named) return named;
  // KeyboardEvent.key is the produced character for printables, with shift
  // already applied ("A", "$"). Multi-char values ("Shift", "F5", "Process")
  // are named keys we don't handle.
  if (event.key.length === 1) return event.key;
  return null;
}

/** A single printable character (valid target for f/t/r and text objects). */
export function isPrintable(key: VimKey): boolean {
  return key.length === 1;
}

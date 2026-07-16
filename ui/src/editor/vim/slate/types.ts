import type { Descendant } from "slate";
import type { FindKind, VimMode } from "../core/ast";

/** The unnamed register. Linewise yanks paste as whole blocks. */
export interface Register {
  kind: "char" | "line";
  fragment: Descendant[];
}

export interface LastFind {
  kind: FindKind;
  char: string;
}

/**
 * Vim session state owned by the React layer and threaded through command
 * execution. Executors return partial patches; they never own the store.
 */
export interface VimState {
  mode: VimMode;
  register: Register | null;
  lastFind: LastFind | null;
  /** Desired column for j/k runs across short lines. */
  goalColumn: number | null;
  /** Anchor of the current visual selection, as a (line, offset) position. */
  visualAnchor: LinePos | null;
  visualKind: "char" | "line";
}

export const INITIAL_VIM_STATE: VimState = {
  mode: "normal",
  register: null,
  lastFind: null,
  goalColumn: null,
  visualAnchor: null,
  visualKind: "char",
};

/** A position in vim's (line, column) coordinate space. */
export interface LinePos {
  li: number;
  off: number;
}

import type { Command, FindKind, Motion, Operator, VimMode } from "./ast";
import { isPrintable, type VimKey } from "./keys";
import {
  actionCommand,
  FIND_KEYS,
  INSERT_KEYS,
  MOTION_KEYS,
  OPERATOR_KEYS,
  TEXT_OBJECT_KEYS,
} from "./keymaps";

export type ParseResult =
  | { kind: "pending" }
  | { kind: "command"; command: Command }
  /** Consumed a nonsense sequence; internal state was reset (vim's beep). */
  | { kind: "invalid" }
  /** Key means nothing at the start of a command; caller decides fallthrough. */
  | { kind: "passthrough" };

type Await =
  | { t: "find"; kind: FindKind }
  | { t: "replace" }
  | { t: "textobj"; around: boolean }
  | { t: "g" };

export interface VimParser {
  feed(key: VimKey, mode: Extract<VimMode, "normal" | "visual">): ParseResult;
  reset(): void;
  /** Keys accumulated since the last reset, for status-bar display. */
  readonly pending: string;
}

/**
 * Incremental parser for the vim command grammar.
 *
 * Consumes one VimKey at a time and emits a Command when a full sequence
 * (e.g. `2d3w`, `ci(`, `dfx`) completes. Operator-pending is a parser state,
 * not an editor mode. Deliberately timeout-free: vim waits forever after `d`.
 */
export function createVimParser(): VimParser {
  let count1: number | null = null;
  let op: Operator | null = null;
  let count2: number | null = null;
  let awaiting: Await | null = null;
  let keys: VimKey[] = [];

  const reset = () => {
    count1 = null;
    op = null;
    count2 = null;
    awaiting = null;
    keys = [];
  };

  /** Combined count; null when neither count was typed (G vs 5G). */
  const product = (): number | null =>
    count1 === null && count2 === null
      ? null
      : (count1 ?? 1) * (count2 ?? 1);

  const emit = (command: Command): ParseResult => {
    reset();
    return { kind: "command", command };
  };

  const invalid = (): ParseResult => {
    reset();
    return { kind: "invalid" };
  };

  const pending = (): ParseResult => ({ kind: "pending" });

  const finishMotion = (motion: Motion): ParseResult => {
    const count = product();
    if (op) return emit({ t: "op-motion", op, motion, count });
    return emit({ t: "move", motion, count });
  };

  const feedAwaiting = (key: VimKey, mode: VimMode): ParseResult => {
    const state = awaiting;
    if (!state) throw new Error("feedAwaiting without awaiting state");
    switch (state.t) {
      case "find": {
        if (!isPrintable(key)) return invalid();
        return finishMotion({ t: "find", kind: state.kind, char: key });
      }
      case "replace": {
        if (!isPrintable(key)) return invalid();
        return emit({ t: "replace-char", char: key, count: count1 ?? 1 });
      }
      case "textobj": {
        const kind = TEXT_OBJECT_KEYS[key];
        if (kind === undefined) return invalid();
        const object = { around: state.around, kind };
        if (mode === "visual") return emit({ t: "visual-object", object });
        if (op) return emit({ t: "op-object", op, object });
        return invalid();
      }
      case "g": {
        if (key !== "g") return invalid();
        return finishMotion({ t: "doc", edge: "first" });
      }
    }
  };

  const feed: VimParser["feed"] = (key, mode) => {
    keys.push(key);

    if (awaiting) return feedAwaiting(key, mode);

    // Counts. A bare "0" is the line-start motion; "0" after a digit
    // extends the count (so "10j" works but "0" still goes to column 0).
    if (/^[0-9]$/.test(key)) {
      const digit = Number(key);
      if (op !== null) {
        if (key !== "0" || count2 !== null) {
          count2 = (count2 ?? 0) * 10 + digit;
          return pending();
        }
      } else if (key !== "0" || count1 !== null) {
        count1 = (count1 ?? 0) * 10 + digit;
        return pending();
      }
      // Bare "0": fall through as a motion.
    }

    if (op !== null) {
      // Operator-pending.
      if (key === op) return emit({ t: "op-line", op, count: product() });
      const motion = MOTION_KEYS[key];
      if (motion) return finishMotion(motion);
      const findKind = FIND_KEYS[key];
      if (findKind) {
        awaiting = { t: "find", kind: findKind };
        return pending();
      }
      if (key === "g") {
        awaiting = { t: "g" };
        return pending();
      }
      if (key === "i" || key === "a") {
        awaiting = { t: "textobj", around: key === "a" };
        return pending();
      }
      if (key === "0") return finishMotion({ t: "line-start" });
      return invalid();
    }

    if (mode === "visual") {
      const operator = OPERATOR_KEYS[key];
      if (operator) return emit({ t: "visual-op", op: operator });
      if (key === "x") return emit({ t: "visual-op", op: "d" });
      if (key === "i" || key === "a") {
        awaiting = { t: "textobj", around: key === "a" };
        return pending();
      }
      if (key === "v") return emit({ t: "enter-visual", linewise: false });
      if (key === "V") return emit({ t: "enter-visual", linewise: true });
    } else {
      const operator = OPERATOR_KEYS[key];
      if (operator) {
        op = operator;
        return pending();
      }
      const where = INSERT_KEYS[key];
      if (where) return emit({ t: "enter-insert", where });
      if (key === "v") return emit({ t: "enter-visual", linewise: false });
      if (key === "V") return emit({ t: "enter-visual", linewise: true });
      if (key === "r") {
        awaiting = { t: "replace" };
        return pending();
      }
      const action = actionCommand(key, count1 ?? 1);
      if (action) return emit(action);
    }

    // Shared by normal and visual mode.
    const motion = MOTION_KEYS[key];
    if (motion) return finishMotion(motion);
    const findKind = FIND_KEYS[key];
    if (findKind) {
      awaiting = { t: "find", kind: findKind };
      return pending();
    }
    if (key === "g") {
      awaiting = { t: "g" };
      return pending();
    }
    if (key === "0") return finishMotion({ t: "line-start" });
    if (key === "<Esc>") return emit({ t: "escape" });

    // Unknown at the start of a command. Vim discards a dangling count.
    if (count1 !== null) return invalid();
    reset();
    return { kind: "passthrough" };
  };

  return {
    feed,
    reset,
    get pending() {
      return keys.join("");
    },
  };
}

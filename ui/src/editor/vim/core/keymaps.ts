import type {
  Command,
  FindKind,
  InsertWhere,
  Motion,
  Operator,
  TextObjectKind,
} from "./ast";
import type { VimKey } from "./keys";

/** Motions that complete immediately on a single key. */
export const MOTION_KEYS: Record<string, Motion> = {
  h: { t: "char", dir: -1 },
  l: { t: "char", dir: 1 },
  "<Left>": { t: "char", dir: -1 },
  "<Right>": { t: "char", dir: 1 },
  j: { t: "line-vert", dir: 1 },
  k: { t: "line-vert", dir: -1 },
  "<Down>": { t: "line-vert", dir: 1 },
  "<Up>": { t: "line-vert", dir: -1 },
  w: { t: "word", kind: "w" },
  b: { t: "word", kind: "b" },
  e: { t: "word", kind: "e" },
  $: { t: "line-end" },
  "^": { t: "first-nonblank" },
  G: { t: "doc", edge: "last" },
  ";": { t: "repeat-find", reverse: false },
  ",": { t: "repeat-find", reverse: true },
};

export const OPERATOR_KEYS: Record<string, Operator> = {
  d: "d",
  c: "c",
  y: "y",
};

export const FIND_KEYS: Record<string, FindKind> = {
  f: "f",
  F: "F",
  t: "t",
  T: "T",
};

export const INSERT_KEYS: Record<string, InsertWhere> = {
  i: "here",
  a: "after",
  I: "first-nonblank",
  A: "line-end",
  o: "open-below",
  O: "open-above",
};

/** Text object target chars, including vim aliases (b = (), B = {}). */
export const TEXT_OBJECT_KEYS: Record<string, TextObjectKind> = {
  w: "w",
  '"': '"',
  "'": "'",
  "`": "`",
  "(": "(",
  ")": "(",
  b: "(",
  "[": "[",
  "]": "[",
  "{": "{",
  "}": "{",
  B: "{",
  "<": "<",
  ">": "<",
};

/** Normal-mode actions that complete on a single key (with optional count). */
export function actionCommand(key: VimKey, count: number): Command | null {
  switch (key) {
    case "x":
      return { t: "delete-char", count };
    case "p":
      return { t: "paste", after: true, count };
    case "P":
      return { t: "paste", after: false, count };
    case "u":
      return { t: "undo", count };
    case "<C-r>":
      return { t: "redo", count };
    case "J":
      return { t: "join", count };
    case "~":
      return { t: "toggle-case", count };
    default:
      return null;
  }
}

/**
 * Vim command AST.
 *
 * Pure data types shared between the parser (which produces them from
 * keystrokes) and the Slate adapter (which executes them). No Slate, React,
 * or DOM dependencies.
 */

export type WordKind = "w" | "b" | "e";
export type FindKind = "f" | "t" | "F" | "T";
export type Operator = "d" | "c" | "y";

export type Motion =
  | { t: "char"; dir: -1 | 1 }
  | { t: "line-vert"; dir: -1 | 1 }
  | { t: "word"; kind: WordKind }
  | { t: "line-start" }
  | { t: "line-end" }
  | { t: "first-nonblank" }
  | { t: "doc"; edge: "first" | "last" }
  | { t: "find"; kind: FindKind; char: string }
  | { t: "repeat-find"; reverse: boolean };

export type TextObjectKind = "w" | '"' | "'" | "`" | "(" | "[" | "{" | "<";

export interface TextObject {
  around: boolean;
  kind: TextObjectKind;
}

export type InsertWhere =
  | "here"
  | "after"
  | "first-nonblank"
  | "line-end"
  | "open-below"
  | "open-above";

/**
 * `count` is `null` when no count was typed. Executors treat that as 1,
 * except where vim distinguishes (`G` = last line, `5G` = line 5).
 */
export type Command =
  | { t: "move"; motion: Motion; count: number | null }
  | { t: "op-motion"; op: Operator; motion: Motion; count: number | null }
  | { t: "op-line"; op: Operator; count: number | null }
  | { t: "op-object"; op: Operator; object: TextObject }
  | { t: "visual-op"; op: Operator }
  | { t: "visual-object"; object: TextObject }
  | { t: "enter-visual"; linewise: boolean }
  | { t: "enter-insert"; where: InsertWhere }
  | { t: "delete-char"; count: number }
  | { t: "paste"; after: boolean; count: number }
  | { t: "replace-char"; char: string; count: number }
  | { t: "toggle-case"; count: number }
  | { t: "join"; count: number }
  | { t: "undo"; count: number }
  | { t: "redo"; count: number }
  | { t: "escape" };

export type VimMode = "normal" | "insert" | "visual";

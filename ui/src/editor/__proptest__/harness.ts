/**
 * Discovery harness for list ("bullet") editing. Not production code.
 *
 * Drives the production plugin chain headlessly with explicit operation
 * histories. Oracles work on a flat outline of lines, a different
 * representation from production's tree, so they cannot share its bugs.
 */
import fc from "fast-check";
import {
  createEditor,
  type Descendant,
  Editor,
  Node,
  Path,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import { HistoryEditor, withHistory } from "slate-history";
import { withReact } from "slate-react";
import { markdownToSlate, slateToMarkdown } from "../convert";
import { withAutoformat } from "../plugins/autoformat/withAutoformat";
import { withBlockVoidDeletion } from "../plugins/withBlockVoidDeletion";
import { withInlinePunctuationBoundary } from "../plugins/withInlinePunctuationBoundary";
import { withMarkdownPaste } from "../plugins/withMarkdownPaste";
import { withMathClipboard } from "../plugins/withMathClipboard";
import {
  indentListItem,
  moveBlockDown,
  moveBlockUp,
  outdentListItem,
  toggleCheckbox,
  withOutliner,
} from "../plugins/withOutliner";
import { withTables } from "../plugins/withTables";
import { withSchema } from "../schema/withSchema";
import "../types";

// ---------------------------------------------------------------------------
// Editor (same chain as SlateEditor.tsx)
// ---------------------------------------------------------------------------

export function makeEditor(children: Descendant[]): Editor {
  const editor = withMathClipboard(
    withMarkdownPaste(
      withReact(
        withInlinePunctuationBoundary(
          withHistory(
            withAutoformat(
              withOutliner(
                withBlockVoidDeletion(withTables(withSchema(createEditor()))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  editor.children = clone(children);
  Editor.normalize(editor, { force: true });
  return editor;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/** Slate flushes `operations` in a microtask; history batching depends on it. */
export async function tick() {
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Document generation
// ---------------------------------------------------------------------------

type InlineKind = "plain" | "empty" | "void" | "marked" | "voidText" | "space";
interface ItemSpec {
  inline: InlineKind;
  checked: boolean | null;
  extra: "none" | "para" | "code" | "quote";
  kids: ListSpec[];
}
interface ListSpec {
  ordered: boolean;
  items: ItemSpec[];
}
type BlockSpec = { para: InlineKind } | { list: ListSpec };

export interface DocProfile {
  voids: boolean;
  extras: boolean;
  tasks: boolean;
  empties: boolean;
}

function arbInline(p: DocProfile): fc.Arbitrary<InlineKind> {
  const opts: fc.WeightedArbitrary<InlineKind>[] = [
    { weight: 8, arbitrary: fc.constant("plain" as const) },
    { weight: 1, arbitrary: fc.constant("marked" as const) },
  ];
  if (p.empties) {
    opts.push({ weight: 2, arbitrary: fc.constant("empty" as const) });
    opts.push({ weight: 1, arbitrary: fc.constant("space" as const) });
  }
  if (p.voids) {
    opts.push({ weight: 2, arbitrary: fc.constant("void" as const) });
    opts.push({ weight: 1, arbitrary: fc.constant("voidText" as const) });
  }
  return fc.oneof(...opts);
}

function arbList(p: DocProfile, depth: number): fc.Arbitrary<ListSpec> {
  const kids: fc.Arbitrary<ListSpec[]> =
    depth <= 0
      ? fc.constant([])
      : fc.oneof(
          { weight: 5, arbitrary: fc.constant([]) },
          {
            weight: 3,
            arbitrary: arbList(p, depth - 1).map((l) => [l]),
          },
          {
            weight: 1,
            arbitrary: fc.tuple(arbList(p, depth - 1), arbList(p, depth - 1)),
          },
        );
  const item: fc.Arbitrary<ItemSpec> = fc.record({
    inline: arbInline(p),
    checked: p.tasks
      ? fc.oneof(
          { weight: 4, arbitrary: fc.constant(null) },
          { weight: 1, arbitrary: fc.boolean() },
        )
      : fc.constant(null),
    extra: p.extras
      ? fc.oneof(
          { weight: 8, arbitrary: fc.constant("none" as const) },
          { weight: 1, arbitrary: fc.constant("para" as const) },
          { weight: 1, arbitrary: fc.constant("code" as const) },
          { weight: 1, arbitrary: fc.constant("quote" as const) },
        )
      : fc.constant("none" as const),
    kids,
  });
  return fc.record({
    ordered: fc.oneof(
      { weight: 5, arbitrary: fc.constant(false) },
      { weight: 1, arbitrary: fc.constant(true) },
    ),
    items: fc.array(item, { minLength: 1, maxLength: 4 }),
  });
}

export function arbDoc(p: DocProfile): fc.Arbitrary<BlockSpec[]> {
  const block: fc.Arbitrary<BlockSpec> = fc.oneof(
    { weight: 1, arbitrary: arbInline(p).map((para) => ({ para })) },
    { weight: 4, arbitrary: arbList(p, 2).map((list) => ({ list })) },
  );
  return fc.array(block, { minLength: 1, maxLength: 3 });
}

const LETTERS = "abcdefghijklmnopqrstuvwxyz";

/** Lowercase letters only, so labels never parse as Markdown or autoformat. */
function label(n: number): string {
  return `${LETTERS[n % 26]}${LETTERS[Math.floor(n / 26) % 26]}`;
}

export function buildDoc(spec: BlockSpec[]): Descendant[] {
  let n = 0;
  const inlines = (k: InlineKind): Descendant[] => {
    const l = label(n++);
    switch (k) {
      case "empty":
        return [{ text: "" }];
      case "space":
        return [{ text: " " }];
      case "marked":
        return [{ text: `${l}x` }, { text: `${l}y`, bold: true }];
      case "void":
        return [
          { text: "" },
          { type: "wikilink", target: `W${n}`, children: [{ text: "" }] },
          { text: "" },
        ] as Descendant[];
      case "voidText":
        return [
          { text: `${l} ` },
          { type: "wikilink", target: `W${n}`, children: [{ text: "" }] },
          { text: "" },
        ] as Descendant[];
      default:
        return [{ text: `${l}txt` }];
    }
  };
  const list = (s: ListSpec): Descendant =>
    ({
      type: s.ordered ? "numbered-list" : "bulleted-list",
      children: s.items.map((it) => {
        const children: Descendant[] = [
          { type: "paragraph", children: inlines(it.inline) } as Descendant,
        ];
        if (it.extra === "para") {
          children.push({
            type: "paragraph",
            children: [{ text: `${label(n++)}par` }],
          } as Descendant);
        } else if (it.extra === "code") {
          children.push({
            type: "code-block",
            children: [{ text: `${label(n++)}code` }],
          } as Descendant);
        } else if (it.extra === "quote") {
          children.push({
            type: "blockquote",
            children: [
              {
                type: "paragraph",
                children: [{ text: `${label(n++)}quo` }],
              },
            ],
          } as Descendant);
        }
        children.push(...it.kids.map(list));
        const el: Record<string, unknown> = { type: "list-item", children };
        if (it.checked !== null) el.checked = it.checked;
        return el as unknown as Descendant;
      }),
    }) as unknown as Descendant;
  const out: Descendant[] = spec.map((b) =>
    "para" in b
      ? ({ type: "paragraph", children: inlines(b.para) } as Descendant)
      : list(b.list),
  );
  return out;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export type Caret =
  | { at: "start" | "end"; line: number }
  | { at: "mid"; line: number; off: number };

export type Op =
  | { k: "caret"; c: Caret }
  | { k: "range"; a: Caret; b: Caret }
  | { k: "type"; ch: string }
  | { k: "enter" }
  | { k: "soft" }
  | { k: "bs" }
  | { k: "del" }
  | { k: "tab" }
  | { k: "untab" }
  | { k: "up" }
  | { k: "down" }
  | { k: "toggle" }
  | { k: "undo" }
  | { k: "redo" };

export const OP_KINDS = [
  "type",
  "enter",
  "soft",
  "bs",
  "del",
  "tab",
  "untab",
  "up",
  "down",
  "toggle",
  "undo",
  "redo",
  "range",
] as const;
export type OpKind = (typeof OP_KINDS)[number];

const arbCaret: fc.Arbitrary<Caret> = fc.oneof(
  fc.record({
    at: fc.constantFrom("start" as const, "end" as const),
    line: fc.nat(40),
  }),
  fc.record({ at: fc.constant("mid" as const), line: fc.nat(40), off: fc.nat(8) }),
);

export function arbOps(
  enabled: readonly OpKind[],
  typedAlphabet: readonly string[],
  maxLength: number,
): fc.Arbitrary<Op[]> {
  const byKind = (k: OpKind): fc.Arbitrary<Op> => {
    if (k === "type") {
      return fc.constantFrom(...typedAlphabet).map((ch) => ({ k: "type", ch }));
    }
    if (k === "range") {
      return fc.record({
        k: fc.constant("range" as const),
        a: arbCaret,
        b: arbCaret,
      });
    }
    return fc.constant({ k } as Op);
  };
  const act = fc.oneof(...enabled.map(byKind));
  const step: fc.Arbitrary<Op[]> = fc.oneof(
    {
      weight: 3,
      arbitrary: fc.tuple(arbCaret, act).map(([c, a]): Op[] => [
        { k: "caret", c },
        a,
      ]),
    },
    { weight: 2, arbitrary: act.map((a): Op[] => [a]) },
  );
  return fc
    .array(step, { minLength: 1, maxLength })
    .map((steps) => steps.flat());
}

// ---------------------------------------------------------------------------
// Outline: flat lines, independent of the production tree
// ---------------------------------------------------------------------------

const VOID_BASE = 0xe000;

/** One private-use char per void, so reading offsets stay single-char. */
function voidChar(node: { target?: string }): string {
  const n = Number((node.target ?? "").replace(/\D/g, "")) || 0;
  return String.fromCharCode(VOID_BASE + (n % 4000));
}

export function blockText(block: SlateElement): string {
  let s = "";
  for (const c of block.children) {
    if (Text.isText(c)) s += c.text;
    else if (SlateElement.isElement(c)) {
      const inline = c as SlateElement & { target?: string };
      if (c.type === "wikilink") s += voidChar(inline);
      else s += blockText(c);
    }
  }
  return s;
}

export interface Line {
  /** Number of enclosing lists (plus blockquotes inside items). */
  depth: number;
  /** `b`/`n`: first block of an item; `p`: paragraph; else the block type. */
  kind: string;
  text: string;
  checked: boolean | null;
  /** Path of the text-bearing block. */
  path: Path;
  /** Path key of the list holding this line's item, if any. */
  listKey: string | null;
  /** That list sits inside a list-item. */
  nested: boolean;
}

const isList = (n: Node) =>
  SlateElement.isElement(n) &&
  (n.type === "bulleted-list" || n.type === "numbered-list");

export function outline(editor: Editor): Line[] {
  const lines: Line[] = [];
  const walkList = (
    n: SlateElement,
    path: Path,
    depth: number,
    nested: boolean,
  ) => {
    const listKey = path.join(".");
    const lead = n.type === "bulleted-list" ? "b" : "n";
    n.children.forEach((item, j) => {
      if (!SlateElement.isElement(item)) return;
      const itemPath = [...path, j];
      let leadUsed = false;
      item.children.forEach((c, k) => {
        if (!SlateElement.isElement(c)) return;
        const p = [...itemPath, k];
        if (isList(c)) {
          if (!leadUsed) {
            // An item whose first child is a list: a visible shape violation.
            lines.push({
              depth: depth + 1,
              kind: `${lead}!`,
              text: "",
              checked: null,
              path: itemPath,
              listKey,
              nested,
            });
            leadUsed = true;
          }
          walkList(c, p, depth + 1, true);
          return;
        }
        if (c.type === "blockquote") {
          walkBlocks(c.children, p, depth + 2);
          return;
        }
        const itemEl = item as SlateElement & { checked?: boolean | null };
        lines.push({
          depth: depth + 1,
          kind: leadUsed ? c.type : lead,
          text: blockText(c),
          checked: leadUsed ? null : (itemEl.checked ?? null),
          path: p,
          listKey,
          nested,
        });
        leadUsed = true;
      });
    });
  };
  const walkBlocks = (nodes: Descendant[], base: Path, depth: number) => {
    nodes.forEach((n, i) => {
      const path = [...base, i];
      if (!SlateElement.isElement(n)) return;
      if (isList(n)) walkList(n, path, depth, false);
      else if (n.type === "blockquote") walkBlocks(n.children, path, depth);
      else {
        lines.push({
          depth,
          kind: n.type === "paragraph" ? "p" : n.type,
          text: blockText(n),
          checked: null,
          path,
          listKey: null,
          nested: false,
        });
      }
    });
  };
  walkBlocks(editor.children, [], 0);
  return lines;
}

/** Editable (non-void) text leaves of a block. */
function editableLeaves(editor: Editor, blockPath: Path) {
  const out: { path: Path; len: number }[] = [];
  for (const [n, p] of Editor.nodes(editor, {
    at: blockPath,
    match: Text.isText,
    voids: false,
  })) {
    if (Text.isText(n)) out.push({ path: p, len: n.text.length });
  }
  return out;
}

export function resolveCaret(editor: Editor, c: Caret) {
  const lines = outline(editor).filter((l) => !l.kind.endsWith("!"));
  if (lines.length === 0) return null;
  const line = lines[c.line % lines.length];
  const leaves = editableLeaves(editor, line.path);
  if (leaves.length === 0) return null;
  if (c.at === "start") return { path: leaves[0].path, offset: 0 };
  if (c.at === "end") {
    const l = leaves[leaves.length - 1];
    return { path: l.path, offset: l.len };
  }
  // Prefer a leaf with text so `mid` is really mid-text.
  const l = leaves.find((x) => x.len > 0) ?? leaves[0];
  return { path: l.path, offset: c.off % (l.len + 1) };
}

// ---------------------------------------------------------------------------
// Applying an operation the way the UI does
// ---------------------------------------------------------------------------

export function applyOp(editor: Editor, op: Op): void {
  switch (op.k) {
    case "caret": {
      const p = resolveCaret(editor, op.c);
      if (p) Transforms.select(editor, p);
      return;
    }
    case "range": {
      const a = resolveCaret(editor, op.a);
      const b = resolveCaret(editor, op.b);
      if (a && b) Transforms.select(editor, { anchor: a, focus: b });
      return;
    }
    case "type":
      Editor.insertText(editor, op.ch);
      return;
    case "enter":
      Editor.insertBreak(editor);
      return;
    case "soft":
      Editor.insertSoftBreak(editor);
      return;
    case "bs":
      // slate-react: an expanded selection deletes as a fragment.
      if (editor.selection && Range.isExpanded(editor.selection)) {
        Editor.deleteFragment(editor, { direction: "backward" });
      } else {
        Editor.deleteBackward(editor, { unit: "character" });
      }
      return;
    case "del":
      if (editor.selection && Range.isExpanded(editor.selection)) {
        Editor.deleteFragment(editor, { direction: "forward" });
      } else {
        Editor.deleteForward(editor, { unit: "character" });
      }
      return;
    case "tab":
      indentListItem(editor);
      return;
    case "untab":
      outdentListItem(editor);
      return;
    case "up":
      moveBlockUp(editor);
      return;
    case "down":
      moveBlockDown(editor);
      return;
    case "toggle":
      toggleCheckbox(editor);
      return;
    case "undo":
      HistoryEditor.undo(editor as HistoryEditor);
      return;
    case "redo":
      HistoryEditor.redo(editor as HistoryEditor);
      return;
  }
}

// ---------------------------------------------------------------------------
// Observations
// ---------------------------------------------------------------------------

export const readingOrder = (ls: Line[]) => ls.map((l) => l.text).join("");
export const stripWs = (s: string) => s.replace(/\s+/g, "");

export interface CaretInfo {
  lineIndex: number;
  /** Offset within the line's text, voids counting as one. */
  lineOffset: number;
  readingIndex: number;
}

export function caretInfo(editor: Editor, ls: Line[]): CaretInfo | null {
  const s = editor.selection;
  if (!s || !Range.isCollapsed(s)) return null;
  const p = s.anchor;
  let readingIndex = 0;
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    if (Path.isAncestor(l.path, p.path)) {
      const before = textBefore(editor, l.path, p);
      return {
        lineIndex: i,
        lineOffset: before,
        readingIndex: readingIndex + before,
      };
    }
    readingIndex += l.text.length;
  }
  return null;
}

function textBefore(
  editor: Editor,
  block: Path,
  p: { path: Path; offset: number },
): number {
  const el = Node.get(editor, block) as SlateElement;
  let count = 0;
  const walk = (n: SlateElement, base: Path): boolean => {
    for (let i = 0; i < n.children.length; i++) {
      const c = n.children[i];
      const cp = [...base, i];
      if (Text.isText(c)) {
        if (Path.equals(cp, p.path)) {
          count += p.offset;
          return true;
        }
        count += c.text.length;
      } else if (SlateElement.isElement(c)) {
        if (c.type === "wikilink") {
          if (Path.isAncestor(cp, p.path)) return true;
          count += 1;
        } else if (walk(c, cp)) return true;
      }
    }
    return false;
  };
  walk(el, block);
  return count;
}

/** Canonical shape from ui/CLAUDE.md, plus selection validity. */
export function shapeViolations(editor: Editor): string[] {
  const out: string[] = [];
  const walk = (n: Descendant, p: Path) => {
    if (!SlateElement.isElement(n)) return;
    if (isList(n)) {
      if (n.children.length === 0) out.push("empty-list");
      for (const c of n.children) {
        if (!(SlateElement.isElement(c) && c.type === "list-item")) {
          out.push("list-child-not-item");
        }
      }
    }
    if (n.type === "list-item") {
      const first = n.children[0];
      if (!first || !SlateElement.isElement(first)) {
        out.push("item-text-child");
      } else if (first.type !== "paragraph") {
        out.push(`item-first-child-${first.type}`);
      }
    }
    n.children.forEach((c, i) => {
      walk(c, [...p, i]);
    });
  };
  editor.children.forEach((c, i) => {
    walk(c, [i]);
  });
  const s = editor.selection;
  if (s) {
    for (const pt of [s.anchor, s.focus]) {
      if (!Editor.hasPath(editor, pt.path)) {
        out.push("selection-bad-path");
        continue;
      }
      const leaf = Node.get(editor, pt.path);
      if (!Text.isText(leaf)) out.push("selection-not-text");
      else if (pt.offset > leaf.text.length) out.push("selection-bad-offset");
    }
  }
  return out;
}

/**
 * Value-level normal form for snapshot comparison: merge equal-mark neighbour
 * leaves, drop empty leaves next to text. Keeps every semantic property.
 */
export function canonical(nodes: Descendant[]): unknown {
  return nodes.map((n) => {
    if (Text.isText(n)) return n;
    const el = n as SlateElement;
    const { children, ...rest } = el as unknown as Record<string, unknown> & {
      children: Descendant[];
    };
    const merged: Descendant[] = [];
    for (const c of children) {
      const last = merged[merged.length - 1];
      if (Text.isText(c) && last && Text.isText(last)) {
        const { text: _a, ...ma } = last;
        const { text: _b, ...mb } = c;
        if (JSON.stringify(ma) === JSON.stringify(mb)) {
          merged[merged.length - 1] = { ...last, text: last.text + c.text };
          continue;
        }
        if (c.text === "") continue;
        if (last.text === "") {
          merged[merged.length - 1] = c;
          continue;
        }
      }
      merged.push(c);
    }
    return { ...rest, children: canonical(merged) };
  });
}

/** Top-level empty paragraphs are a separate, non-list reload question. */
export function comparable(nodes: Descendant[]): unknown {
  return canonical(
    nodes.filter(
      (n) =>
        !(
          SlateElement.isElement(n) &&
          n.type === "paragraph" &&
          Node.string(n) === "" &&
          n.children.length === 1
        ),
    ),
  );
}

export function reload(children: Descendant[]): Descendant[] {
  const md = slateToMarkdown(clone(children));
  const parsed = markdownToSlate(md);
  return makeEditor(parsed).children;
}


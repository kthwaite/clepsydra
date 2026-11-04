/**
 * Targeted census for typed characters running through autoformat in and next
 * to list items. Discovery harness, not production code.
 *
 * The oracles do not read autoformat's own rules. They state what a typist is
 * owed: letters they typed survive, markers that trigger a conversion leave no
 * residue, text around the caret keeps its order, the list shape stays canonical,
 * history returns to its ends, and saving keeps what the screen shows.
 */
import {
  type Descendant,
  Editor,
  Node,
  Range,
  Element as SlateElement,
  Text,
  Transforms,
} from "slate";
import type { HistoryEditor } from "slate-history";
import { slateToMarkdown } from "../convert";
import { firstDivergence } from "./census";
import {
  applyOp,
  canonical,
  clone,
  comparable,
  makeEditor,
  outline,
  reload,
  shapeViolations,
  tick,
} from "./harness";

const p = (text: string, extra: Record<string, unknown> = {}): Descendant =>
  ({
    type: "paragraph",
    ...extra,
    children: [{ text }],
  }) as unknown as Descendant;
const li = (text: string, ...rest: Descendant[]): Descendant =>
  ({
    type: "list-item",
    children: [p(text), ...rest],
  }) as unknown as Descendant;
const task = (
  text: string,
  checked: boolean,
  ...rest: Descendant[]
): Descendant =>
  ({
    type: "list-item",
    checked,
    children: [p(text), ...rest],
  }) as unknown as Descendant;
const ul = (...items: Descendant[]): Descendant =>
  ({ type: "bulleted-list", children: items }) as unknown as Descendant;
const ol = (...items: Descendant[]): Descendant =>
  ({ type: "numbered-list", children: items }) as unknown as Descendant;
const quote = (...children: Descendant[]): Descendant =>
  ({ type: "blockquote", children }) as unknown as Descendant;
const wikilink = (target: string): Descendant =>
  ({
    type: "wikilink",
    target,
    children: [{ text: "" }],
  }) as unknown as Descendant;

export interface StartState {
  name: string;
  doc: Descendant[];
  /** Index into `outline(editor)` of the line that receives the caret. */
  line: number;
  /** Where the target sits, which decides what a block marker should do. */
  ctx: "para" | "item" | "quote" | "extra";
}

export const STATES: StartState[] = [
  { name: "para", doc: [p("abcd")], line: 0, ctx: "para" },
  { name: "emptyPara", doc: [p("")], line: 0, ctx: "para" },
  {
    name: "paraAfterList",
    doc: [ul(li("list")), p("abcd")],
    line: 1,
    ctx: "para",
  },
  {
    name: "emptyParaAfterList",
    doc: [ul(li("list")), p("")],
    line: 1,
    ctx: "para",
  },
  {
    name: "paraBeforeList",
    doc: [p("abcd"), ul(li("list"))],
    line: 0,
    ctx: "para",
  },
  {
    name: "emptyParaBeforeList",
    doc: [p(""), ul(li("list"))],
    line: 0,
    ctx: "para",
  },
  {
    name: "paraBetweenLists",
    doc: [ul(li("oone")), p("abcd"), ul(li("ttwo"))],
    line: 1,
    ctx: "para",
  },
  {
    name: "paraBetweenNumbered",
    doc: [ol(li("oone")), p("abcd"), ol(li("ttwo"))],
    line: 1,
    ctx: "para",
  },
  {
    name: "paraAfterNumbered",
    doc: [ol(li("list")), p("abcd")],
    line: 1,
    ctx: "para",
  },
  {
    name: "paraWithProp",
    doc: [p("abcd", { properties: { pk: "pv" } })],
    line: 0,
    ctx: "para",
  },
  {
    name: "paraWithBlockId",
    doc: [p("abcd", { blockId: "qqqqqqqqqq" })],
    line: 0,
    ctx: "para",
  },
  { name: "item", doc: [ul(li("abcd"), li("next"))], line: 0, ctx: "item" },
  {
    name: "emptyItem",
    doc: [ul(li("prev"), li(""), li("next"))],
    line: 1,
    ctx: "item",
  },
  { name: "soleEmptyItem", doc: [ul(li(""))], line: 0, ctx: "item" },
  {
    name: "taskOpen",
    doc: [ul(task("abcd", false), li("next"))],
    line: 0,
    ctx: "item",
  },
  { name: "taskDone", doc: [ul(task("abcd", true))], line: 0, ctx: "item" },
  {
    name: "emptyTask",
    doc: [ul(li("prev"), task("", false))],
    line: 1,
    ctx: "item",
  },
  {
    name: "nested",
    doc: [ul(li("root", ul(li("abcd"), li("kin"))))],
    line: 1,
    ctx: "item",
  },
  {
    name: "emptyNested",
    doc: [ul(li("root", ul(li("kin"), li(""))))],
    line: 2,
    ctx: "item",
  },
  {
    name: "parent",
    doc: [ul(li("abcd", ul(li("kid"))))],
    line: 0,
    ctx: "item",
  },
  {
    name: "emptyParent",
    doc: [ul(li("", ul(li("kid"))), li("next"))],
    line: 0,
    ctx: "item",
  },
  {
    name: "taskParent",
    doc: [ul(task("abcd", false, ul(li("kid"))))],
    line: 0,
    ctx: "item",
  },
  { name: "numbered", doc: [ol(li("abcd"), li("next"))], line: 0, ctx: "item" },
  {
    name: "emptyNumbered",
    doc: [ol(li("prev"), li(""))],
    line: 1,
    ctx: "item",
  },
  { name: "quotePara", doc: [quote(p("abcd"))], line: 0, ctx: "quote" },
  { name: "emptyQuotePara", doc: [quote(p(""))], line: 0, ctx: "quote" },
  { name: "listInQuote", doc: [quote(ul(li("abcd")))], line: 0, ctx: "item" },
  {
    name: "quoteInItem",
    doc: [ul(li("lead", quote(p("abcd"))))],
    line: 1,
    ctx: "quote",
  },
  {
    name: "itemSecondPara",
    doc: [ul(li("lead", p("abcd")))],
    line: 1,
    ctx: "extra",
  },
  {
    name: "itemSecondParaKids",
    doc: [ul(li("lead", p("abcd"), ul(li("kid"))))],
    line: 1,
    ctx: "extra",
  },
  {
    name: "itemWithProp",
    doc: [
      ul({
        type: "list-item",
        properties: { pk: "pv" },
        children: [p("abcd")],
      } as unknown as Descendant),
    ],
    line: 0,
    ctx: "item",
  },
  {
    name: "itemWithBlockId",
    doc: [
      ul({
        type: "list-item",
        blockId: "qqqqqqqqqq",
        children: [p("abcd")],
      } as unknown as Descendant),
    ],
    line: 0,
    ctx: "item",
  },
  {
    name: "itemMarkedTail",
    doc: [
      ul({
        type: "list-item",
        children: [
          {
            type: "paragraph",
            children: [{ text: "ab " }, { text: "cd", bold: true }],
          },
        ],
      } as unknown as Descendant),
    ],
    line: 0,
    ctx: "item",
  },
  {
    name: "itemLinkTail",
    doc: [
      ul({
        type: "list-item",
        children: [
          {
            type: "paragraph",
            children: [{ text: "ab " }, wikilink("Wik"), { text: "" }],
          },
        ],
      } as unknown as Descendant),
    ],
    line: 0,
    ctx: "item",
  },
  { name: "itemTrailingSpace", doc: [ul(li("abcd "))], line: 0, ctx: "item" },
  { name: "itemTwoWords", doc: [ul(li("ab cde"))], line: 0, ctx: "item" },
  {
    name: "lastPara",
    doc: [p("list"), quote(p("qq")), p("abcd")],
    line: 2,
    ctx: "para",
  },
];

export interface Token {
  text: string;
  /** Letters the typist typed that must survive anywhere in the document. */
  letters: string;
  kind:
    | "listMark"
    | "taskMark"
    | "blockMark"
    | "hr"
    | "inline"
    | "voidInline"
    | "displayMath"
    | "other";
}

export const TOKENS: Token[] = [
  { text: "- ", letters: "", kind: "listMark" },
  { text: "* ", letters: "", kind: "listMark" },
  { text: "1. ", letters: "1", kind: "listMark" },
  { text: "7. ", letters: "7", kind: "listMark" },
  { text: "[ ] ", letters: "", kind: "taskMark" },
  { text: "[x] ", letters: "x", kind: "taskMark" },
  { text: "[] ", letters: "", kind: "taskMark" },
  { text: "---", letters: "", kind: "hr" },
  { text: "> ", letters: "", kind: "blockMark" },
  { text: "# ", letters: "", kind: "blockMark" },
  { text: "```", letters: "", kind: "other" },
  { text: "**x**", letters: "x", kind: "inline" },
  { text: "***x***", letters: "x", kind: "other" },
  { text: "*x*", letters: "x", kind: "inline" },
  { text: "_x_", letters: "x", kind: "inline" },
  { text: "~x~", letters: "x", kind: "inline" },
  { text: "`x`", letters: "x", kind: "inline" },
  { text: "[[x]]", letters: "x", kind: "voidInline" },
  { text: "[[", letters: "", kind: "other" },
  { text: "]]", letters: "", kind: "other" },
  { text: "$x$", letters: "x", kind: "voidInline" },
  { text: "$$x$$", letters: "x", kind: "displayMath" },
  { text: "\\[x\\]", letters: "x", kind: "displayMath" },
  { text: "\\(x\\)", letters: "x", kind: "voidInline" },
  { text: "^", letters: "", kind: "other" },
  { text: "[^x]", letters: "x", kind: "voidInline" },
  { text: "[k:: v]", letters: "kv", kind: "other" },
  { text: " [k:: v]", letters: "kv", kind: "other" },
  { text: " ^abcdefghij", letters: "abcdefghij", kind: "other" },
  { text: "\\", letters: "", kind: "other" },
  { text: "\\*", letters: "", kind: "other" },
  { text: "[y](u)", letters: "yu", kind: "voidInline" },
  { text: "[ ]", letters: "", kind: "other" },
  { text: "[x]", letters: "x", kind: "other" },
  { text: "[", letters: "", kind: "other" },
  { text: "+ ", letters: "", kind: "other" },
  { text: "1) ", letters: "1", kind: "other" },
  { text: "$ [k:: v]", letters: "kv", kind: "other" },
  { text: "`[k:: v]`", letters: "kv", kind: "other" },
  { text: "\\[k:: v]", letters: "kv", kind: "other" },
  { text: "x ^", letters: "x", kind: "other" },
  { text: "[[x|y]]", letters: "xy", kind: "voidInline" },
  { text: "((abcdefghij))", letters: "abcdefghij", kind: "other" },
  { text: "<https://u.io>", letters: "httpsuio", kind: "other" },
  { text: "https://u.io ", letters: "httpsuio", kind: "other" },
  { text: "*", letters: "", kind: "other" },
  { text: "_", letters: "", kind: "other" },
];

export const FOLLOWS = [
  "none",
  "enter",
  "bs",
  "del",
  "tab",
  "untab",
  "undo",
  "undoredo",
  "typeZ",
  "undoZ",
] as const;
export type Follow = (typeof FOLLOWS)[number];

export const POSITIONS = ["start", "mid", "end", "range"] as const;
export type Position = (typeof POSITIONS)[number];

export interface Violation {
  sig: string;
  detail: string;
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );

const NON_CONTENT_KEYS = new Set([
  "type",
  "delimiter",
  "checked",
  "children",
  "level",
  "ordered",
  "start",
]);

/** Every alphanumeric the document holds, wherever it lives (text or attribute). */
export function contentBag(nodes: Descendant[]): string {
  const out: string[] = [];
  const add = (s: string) => {
    for (const ch of s) if (/[A-Za-z0-9]/.test(ch)) out.push(ch);
  };
  const ids = new Set<string>();
  const walk = (n: unknown) => {
    if (typeof n === "string") add(n);
    else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === "object") {
      const typed = n as { type?: string };
      for (const [k, v] of Object.entries(n)) {
        if (k === "children") walk(v);
        else if (typed.type === "footnote-def" && k === "identifier") continue;
        else if (k === "blockId") {
          if (!ids.has(v as string)) add(v as string);
          ids.add(v as string);
        } else if (k === "properties") {
          for (const [pk, pv] of Object.entries(v as Record<string, string>)) {
            add(pk);
            add(pv);
          }
        } else if (!NON_CONTENT_KEYS.has(k) && typeof v === "string") add(v);
      }
    }
  };
  walk(nodes);
  return out.sort().join("");
}

const sorted = (s: string) => [...s].sort().join("");

/** The visible words, in order. Metadata and block boundaries do not show here. */
function visibleText(nodes: Descendant[]): string {
  const walk = (n: Descendant): string => {
    if (Text.isText(n)) return n.text;
    const el = n as SlateElement & {
      target?: string;
      tex?: string;
      identifier?: string;
    };
    if (el.type === "wikilink") return `«${el.target}»`;
    if (el.type === "inline-math" || el.type === "math-block")
      return `«${(el.tex ?? "").trim()}»`;
    if (el.type === "footnote-ref") return `«${el.identifier}»`;
    return el.children.map(walk).join("");
  };
  return nodes.map(walk).join("").replace(/\s+/g, "");
}

/** Same comparison as `comparable`, but insensitive to spaces at block edges. */
function comparableWs(nodes: Descendant[]): unknown {
  const walk = (n: unknown): unknown => {
    if (Array.isArray(n)) return n.map(walk);
    if (n && typeof n === "object") {
      const raw = n as Record<string, unknown>;
      const o: Record<string, unknown> = {};
      for (const k of Object.keys(raw).sort()) o[k] = raw[k];
      if (typeof o.text === "string")
        o.text = o.text.replace(/\s+/g, " ").trim();
      if (o.children) {
        o.children = (o.children as unknown[]).map(walk).filter((c) => {
          const t = c as { text?: string };
          return !(typeof t.text === "string" && t.text === "");
        });
      }
      return o;
    }
    return n;
  };
  return walk(comparable(nodes));
}

/**
 * Root causes already written up. A reload of such a document is skipped, so the
 * census can see past them. `CENSUS_NO_MASK=1` runs the raw oracles.
 */
export function knownReloadCause(nodes: Descendant[]): string | null {
  if (process.env.CENSUS_NO_MASK === "1") return null;
  const md = slateToMarkdown(clone(nodes));
  if (/^[\s>*+-]*(\d+[.)]\s+)?(\[[ xX]\]\s+)?\\\[/m.test(md))
    return "A1-bracket-escape";
  let found: string | null = null;
  const walk = (n: Descendant) => {
    if (Text.isText(n)) return;
    const el = n as SlateElement & {
      blockId?: string;
      properties?: Record<string, string>;
      checked?: boolean | null;
    };
    if (el.children.length && Editor.isEditor(n) === false) {
      const phrasing = el.children.filter(
        (c) => Text.isText(c) || !Editor.isEditor(c),
      );
      const joined = phrasing
        .map((c) =>
          Text.isText(c) ? c.text : SlateElement.isElement(c) ? "\uFFFC" : "",
        )
        .join("");
      if (/\[[A-Za-z_][\w-]*::[ \t]+[^\]]+\]/.test(joined))
        found ??= "A11-literal-property";
      if (
        /\s\^[A-Za-z0-9]{10,12}\s*$/.test(joined) ||
        /^\s*\^[A-Za-z0-9]{10,12}\s*$/.test(joined)
      )
        found ??= "A11-literal-blockid";
      if (el.blockId && el.children.length > 0 && el.type !== "list-item") {
        // A paragraph duplicate id is the Enter-split finding.
      }
      for (let i = 0; i + 1 < el.children.length; i++) {
        const a = el.children[i];
        const b = el.children[i + 1];
        if (Text.isText(a) && Text.isText(b)) {
          const am = a.bold || a.italic || a.strikethrough;
          const bm = b.bold || b.italic || b.strikethrough;
          // A delimiter run next to a word and to punctuation or a space is not flanking.
          if (am && /[\s\p{P}\p{S}]$/u.test(a.text) && b.text !== "")
            found ??= "A13-mark-flanking";
          if (bm && /^[\s\p{P}\p{S}]/u.test(b.text) && a.text !== "")
            found ??= "A13-mark-flanking";
        }
        if (
          SlateElement.isElement(a) &&
          a.type === "inline-math" &&
          Text.isText(b) &&
          b.text === "" &&
          SlateElement.isElement(el.children[i + 2]) &&
          (el.children[i + 2] as SlateElement).type === "inline-math"
        ) {
          found ??= "A14-adjacent-math";
        }
      }
    }
    const blocks = el.children.filter((c) => SlateElement.isElement(c));
    const isListEl = (c: Descendant) =>
      SlateElement.isElement(c) &&
      (c.type === "bulleted-list" || c.type === "numbered-list");
    if (
      el.children.some(
        (c) => Text.isText(c) && c.text === "" && Object.keys(c).length > 1,
      )
    )
      found ??= "A5-empty-mark";
    if (el.type === "math-block") found ??= "A7-math-indent";
    if (
      (el.type === "paragraph" || el.type === "heading") &&
      (el.properties || el.blockId)
    ) {
      found ??= "A16-block-metadata";
    }
    if (el.type === "list-item") {
      const first = el.children[0];
      if (SlateElement.isElement(first) && first.type !== "paragraph")
        found ??= "shape-first-child";
      const nonList = el.children.filter((c) => !isListEl(c));
      if ((el.properties || el.blockId) && nonList.length > 1)
        found ??= "A9-metadata-multiblock";
      const leadEmpty =
        SlateElement.isElement(first) &&
        first.type === "paragraph" &&
        Node.string(first).trim() === "";
      if (leadEmpty && el.children.length > 1) found ??= "C4-C5-C6-empty-lead";
      if (
        nonList.length > 1 &&
        nonList.slice(1).some((c) => Node.string(c).trim() === "")
      )
        found ??= "item-empty-extra";
      if (leadEmpty && (el.properties || el.blockId || el.checked != null))
        found ??= null;
    }
    if (blocks.length) blocks.forEach(walk);
  };
  nodes.forEach(walk);
  return found;
}

export function reloadStable(children: Descendant[]): boolean {
  try {
    return (
      json(comparableWs(reload(children))) === json(comparableWs(children))
    );
  } catch {
    return false;
  }
}

function placeCaret(e: Editor, line: number, pos: Position) {
  const l = outline(e)[line];
  if (pos === "start") {
    Transforms.select(e, Editor.start(e, l.path));
    return;
  }
  if (pos === "end") {
    Transforms.select(e, Editor.end(e, l.path));
    return;
  }
  const start = Editor.start(e, l.path);
  const leaf = Node.get(e, start.path) as Text;
  if (pos === "range") {
    // An expanded selection inside the first leaf: typing replaces or wraps it.
    Transforms.select(e, {
      anchor: { path: start.path, offset: Math.min(1, leaf.text.length) },
      focus: { path: start.path, offset: Math.min(3, leaf.text.length) },
    });
    return;
  }
  Transforms.select(e, {
    path: start.path,
    offset: Math.floor(leaf.text.length / 2),
  });
}

function lineContaining(e: Editor): { head: string; tail: string } {
  const s = e.selection;
  if (!s) return { head: "", tail: "" };
  const entry = Editor.above(e, {
    at: s.anchor,
    match: (n) => SlateElement.isElement(n) && Editor.isBlock(e, n),
    mode: "lowest",
  });
  if (!entry) return { head: "", tail: "" };
  const head = Editor.string(e, {
    anchor: Editor.start(e, entry[1]),
    focus: s.anchor,
  });
  const tail = Editor.string(e, {
    anchor: s.anchor,
    focus: Editor.end(e, entry[1]),
  });
  return { head, tail };
}

function inItem(e: Editor): boolean {
  const s = e.selection;
  if (!s) return false;
  return !!Editor.above(e, {
    at: s.anchor,
    match: (n) => SlateElement.isElement(n) && n.type === "list-item",
  });
}

async function typeToken(
  e: Editor,
  token: string,
  stepUndo: boolean,
  out: Violation[],
  tag: string,
) {
  const h = e as HistoryEditor;
  for (const ch of token) {
    const pre = clone(e.children);
    const undosBefore = h.history.undos.length;
    applyOp(e, { k: "type", ch });
    await tick();
    if (stepUndo && h.history.undos.length === undosBefore + 1) {
      const post = clone(e.children);
      const postSel = clone(e.selection);
      h.undo();
      await tick();
      if (json(e.children) !== json(pre)) {
        out.push({
          sig: `undo-step:${tag}`,
          detail: `pre=${json(pre)} got=${json(e.children)}`,
        });
      }
      const bad = shapeViolations(e).filter((v) => v.startsWith("selection"));
      if (bad.length)
        out.push({ sig: `undo-step-selection:${bad[0]}`, detail: tag });
      h.redo();
      await tick();
      if (json(e.children) !== json(post)) {
        out.push({
          sig: `redo-step:${tag}`,
          detail: `want=${json(post)} got=${json(e.children)}`,
        });
      }
      if (json(e.selection) !== json(postSel)) {
        out.push({
          sig: `redo-step-selection`,
          detail: `${tag} want=${json(postSel)} got=${json(e.selection)}`,
        });
      }
    }
  }
}

function markerOracle(
  state: StartState,
  pos: Position,
  token: Token,
  head: string,
  tail: string,
  e: Editor,
): Violation | null {
  const atStart = head === "";
  const here = lineContaining(e);
  const textNow = here.head + here.tail;

  if (
    token.kind === "listMark" &&
    atStart &&
    state.ctx !== "item" &&
    state.ctx !== "extra"
  ) {
    // Marker typed at the start of a plain paragraph: a list, and no residue.
    if (!inItem(e) || textNow !== tail) {
      return {
        sig: `marker-residue:${token.text}`,
        detail: `${state.name}/${pos} inItem=${inItem(e)} text=${json(textNow)} want=${json(tail)}`,
      };
    }
  }
  if (
    token.kind === "blockMark" &&
    atStart &&
    state.ctx === "para" &&
    textNow !== tail
  ) {
    return {
      sig: `marker-residue:${token.text}`,
      detail: `${state.name}/${pos} text=${json(textNow)} want=${json(tail)}`,
    };
  }
  if (token.kind === "taskMark" && atStart && state.ctx !== "extra") {
    // Task marker at the start of a block: checked state set, no literal residue.
    const item = Editor.above(e, {
      match: (n) => SlateElement.isElement(n) && n.type === "list-item",
    });
    const want = token.text === "[x] ";
    const checked = item
      ? (item[0] as { checked?: boolean | null }).checked
      : undefined;
    if (checked !== want || textNow !== tail) {
      return {
        sig: `task-marker:${token.text}`,
        detail: `${state.name}/${pos} checked=${checked} text=${json(textNow)} want=${json(tail)}`,
      };
    }
  }
  if (
    token.kind === "inline" &&
    (head === "" || /\s$/.test(head)) &&
    state.name !== "itemLinkTail" &&
    pos !== "mid"
  ) {
    if (textNow !== `${head}x${tail}`) {
      return {
        sig: `inline-residue:${token.text}`,
        detail: `${state.name}/${pos} text=${json(textNow)} want=${json(`${head}x${tail}`)}`,
      };
    }
  }
  return null;
}

/** Every oracle over one typed token and one follow-up action. */
export async function runCase(
  state: StartState,
  pos: Position,
  token: Token,
  follow: Follow,
  opts: {
    stepUndo?: boolean;
    onToken?: (
      e: Editor,
      state: StartState,
      pos: Position,
      token: Token,
    ) => void;
  } = {},
): Promise<Violation[]> {
  const out: Violation[] = [];
  const e = makeEditor(state.doc);
  placeCaret(e, state.line, pos);
  e.history = { undos: [], redos: [] };
  await tick();
  const start = clone(e.children);
  const startSel = clone(e.selection);
  const startStable = reloadStable(start);
  const startBag = contentBag(start);
  const { head, tail } = lineContaining(e);
  const tag = `${state.name}/${pos}/${json(token.text)}/${follow}`;

  if (opts.stepUndo) {
    const probe = makeEditor(state.doc);
    placeCaret(probe, state.line, pos);
    probe.history = { undos: [], redos: [] };
    await tick();
    try {
      await typeToken(probe, token.text, true, out, tag);
    } catch {
      /* the plain run below reports throws */
    }
  }
  try {
    await typeToken(e, token.text, false, out, tag);
  } catch (err) {
    out.push({
      sig: `throw:type:${token.text}`,
      detail: `${tag} ${String(err)}`,
    });
    return out;
  }

  const afterToken = clone(e.children);
  const wantBag = sorted(startBag + token.letters);
  const markerConsumed =
    (token.kind === "listMark" || token.kind === "taskMark") &&
    contentBag(afterToken) === startBag;
  if (
    pos !== "range" &&
    contentBag(afterToken) !== wantBag &&
    !markerConsumed
  ) {
    out.push({
      sig: `lost-typed:${token.text}`,
      detail: `${tag} want=${wantBag} got=${contentBag(afterToken)} doc=${json(afterToken)}`,
    });
  }
  const sv = shapeViolations(e);
  if (sv.length)
    out.push({
      sig: `shape:${token.text}:${sv[0]}`,
      detail: `${tag} ${json(afterToken)}`,
    });

  if (token.text === "[y](u)") {
    const urls: string[] = [];
    for (const [n] of Editor.nodes(e, {
      at: [],
      match: (x) => SlateElement.isElement(x) && x.type === "link",
    })) {
      urls.push((n as unknown as { url: string }).url);
    }
    if (urls.some((u) => u !== "u"))
      out.push({ sig: "link-url", detail: `${tag} urls=${json(urls)}` });
  }
  const marker =
    pos === "range" ? null : markerOracle(state, pos, token, head, tail, e);
  if (marker) out.push(marker);
  opts.onToken?.(e, state, pos, token);

  // A property pair must not glue the words either side of it together.
  if (
    token.text.endsWith("[k:: v]") &&
    /\s$/.test(head) &&
    tail !== "" &&
    !/^\s/.test(tail)
  ) {
    const line = lineContaining(e);
    if (!/\s/.test(line.head + line.tail)) {
      out.push({
        sig: `words-joined:${token.text}`,
        detail: `${tag} head=${json(head)} tail=${json(tail)} now=${json(line.head + line.tail)}`,
      });
    }
  }

  // What the typist sees around the caret stays in order.
  if (follow === "typeZ" && pos !== "range") {
    applyOp(e, { k: "type", ch: "Z" });
    await tick();
    const line = lineContaining(e);
    const ok =
      line.head.endsWith("Z") &&
      (tail === "" ||
        line.tail.includes(tail.trim()) ||
        line.head.includes(tail.trim()));
    if (!ok) {
      out.push({
        sig: `caret-order:${token.text}`,
        detail: `${tag} head=${json(line.head)} tail=${json(line.tail)} wantTail=${json(tail)} doc=${json(e.children)}`,
      });
    }
    if (!contentBag(e.children).includes("Z")) {
      out.push({ sig: `lost-typed:Z`, detail: `${tag} ${json(e.children)}` });
    }
  }

  const beforeFollow = clone(e.children);
  try {
    switch (follow) {
      case "enter":
      case "bs":
      case "del":
      case "tab":
      case "untab":
      case "undo":
        applyOp(e, { k: follow });
        break;
      case "undoredo":
        applyOp(e, { k: "undo" });
        await tick();
        applyOp(e, { k: "redo" });
        break;
      case "undoZ": {
        applyOp(e, { k: "undo" });
        await tick();
        const bagAfterUndo = contentBag(e.children);
        const selAfterUndo = clone(e.selection);
        if (!selAfterUndo)
          out.push({
            sig: `undo-null-selection:${token.kind}`,
            detail: `${tag} ${json(e.children)}`,
          });
        else if (pos !== "range" && Range.isExpanded(selAfterUndo)) {
          out.push({
            sig: `undo-expanded-selection:${token.kind}`,
            detail: `${tag} sel=${json(selAfterUndo)} doc=${json(e.children)}`,
          });
        }
        applyOp(e, { k: "type", ch: "Z" });
        await tick();
        if (
          pos !== "range" &&
          contentBag(e.children) !== sorted(`${bagAfterUndo}Z`)
        ) {
          out.push({
            sig: `undo-then-type-lost:${token.kind}`,
            detail: `${tag} bagBefore=${bagAfterUndo} doc=${json(e.children)}`,
          });
        }
        break;
      }
      default:
        break;
    }
    await tick();
  } catch (err) {
    out.push({
      sig: `throw:${follow}:${token.text}`,
      detail: `${tag} ${String(err)}`,
    });
    return out;
  }

  const sf = shapeViolations(e);
  if (sf.length && !sv.length) {
    out.push({
      sig: `shape-after:${follow}:${sf[0]}`,
      detail: `${tag} before=${json(beforeFollow)} after=${json(e.children)}`,
    });
  }
  if (follow === "enter" || follow === "tab" || follow === "untab") {
    if (contentBag(e.children) !== contentBag(beforeFollow)) {
      out.push({
        sig: `lost-after:${follow}:${token.kind}`,
        detail: `${tag} before=${json(beforeFollow)} after=${json(e.children)}`,
      });
    }
  }
  if (follow === "undoredo" && json(e.children) !== json(beforeFollow)) {
    out.push({
      sig: `undoredo:${token.kind}`,
      detail: `${tag} before=${json(beforeFollow)} after=${json(e.children)}`,
    });
  }
  const endSel = shapeViolations(e).filter((v) => v.startsWith("selection"));
  if (endSel.length)
    out.push({ sig: `selection:${follow}:${endSel[0]}`, detail: tag });

  // Save and reload.
  const endDoc = clone(e.children);
  if (startStable) checkReload(endDoc, tag, follow, token, out);

  // Whole history.
  const h = e as HistoryEditor;
  const beforeUndoAll = clone(e.children);
  let undone = 0;
  while (h.history.undos.length > 0 && undone < 500) {
    h.undo();
    undone++;
    await tick();
  }
  if (json(e.children) !== json(start)) {
    out.push({
      sig: `undo-all:${token.kind}:${follow}`,
      detail: `${tag} start=${json(start)} got=${json(e.children)}`,
    });
  } else if (json(e.selection) !== json(startSel)) {
    out.push({
      sig: `undo-all-selection:${token.kind}`,
      detail: `${tag} want=${json(startSel)} got=${json(e.selection)}`,
    });
  } else {
    for (let i = 0; i < undone; i++) {
      h.redo();
      await tick();
    }
    if (json(e.children) !== json(beforeUndoAll)) {
      out.push({
        sig: `redo-all:${token.kind}:${follow}`,
        detail: `${tag} want=${json(beforeUndoAll)} got=${json(e.children)}`,
      });
    }
  }
  return out;
}

export function checkReload(
  endDoc: Descendant[],
  tag: string,
  follow: string,
  token: { text: string },
  out: Violation[],
) {
  let back: Descendant[];
  if (knownReloadCause(endDoc)) return;
  const md = slateToMarkdown(clone(endDoc));
  try {
    back = reload(endDoc);
  } catch (err) {
    out.push({
      sig: `throw:reload:${token.text}`,
      detail: `${tag} ${String(err)} md=${json(md)}`,
    });
    return;
  }
  if (contentBag(back) !== contentBag(endDoc)) {
    out.push({
      sig: `reload-lost:${token.text}`,
      detail: `${tag} md=${json(md)} now=${json(canonical(endDoc))} back=${json(canonical(back))}`,
    });
  }
  if (visibleText(back) !== visibleText(endDoc)) {
    out.push({
      sig: `reload-visible:${token.text}`,
      detail: `${tag} md=${json(md)} now=${json(canonical(endDoc))} back=${json(canonical(back))}`,
    });
  }
  if (json(comparableWs(back)) !== json(comparableWs(endDoc))) {
    const cls = firstDivergence(comparableWs(endDoc), comparableWs(back));
    out.push({
      sig: `reload:${cls}:${token.text}`,
      detail: `${tag}/${follow} md=${json(md)} now=${json(canonical(endDoc))} back=${json(canonical(back))}`,
    });
  } else if (json(comparable(back)) !== json(comparable(endDoc))) {
    out.push({
      sig: `reload-ws:${token.text}`,
      detail: `${tag} md=${json(md)} now=${json(canonical(endDoc))} back=${json(canonical(back))}`,
    });
  }
  // Saving again must reach a fixed point: a file must not drift per save.
  const md1 = slateToMarkdown(clone(back));
  const back2 = reload(back);
  const md2 = slateToMarkdown(clone(back2));
  const back3 = reload(back2);
  const md3 = slateToMarkdown(clone(back3));
  if (md2 !== md3 || md1 !== md2) {
    out.push({
      sig: `md-drift:${token.text}`,
      detail: `${tag} md=${json(md)} md1=${json(md1)} md2=${json(md2)} md3=${json(md3)}`,
    });
  }
}

export { Range };

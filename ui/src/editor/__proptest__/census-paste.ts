/**
 * Replays one case of structural ops against the paste oracles. Judges only the
 * new ops (paste, selection list, slash, property, checkbox); typing and Enter
 * are there to build interacting histories, and their contracts are census.ts's.
 */
import {
  type Descendant,
  Editor,
  Node,
  type Path,
  Range,
  Element as SlateElement,
  Transforms,
} from "slate";
import type { HistoryEditor } from "slate-history";
import { markdownToSlate, slateToMarkdown } from "../convert";
import { firstDivergence, type Violation } from "./census";
import {
  caretInfo,
  clone,
  comparable,
  type Line,
  makeEditor,
  outline,
  readingOrder,
  reload,
  stripWs,
  tick,
} from "./harness";
import { applyPasteOp, type PasteOp } from "./harness-paste";

const json = (v: unknown) => JSON.stringify(v);
/** Undo may restore a property in another key order; that is not a difference. */
const stable = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.entries(val).sort(([a], [b]) => (a < b ? -1 : 1)),
        )
      : val,
  );
/** Voids read as private-use chars; show them. */
const asciiJson = (s: string) =>
  JSON.stringify(s).replace(
    /[\ue000-\uf8ff]/g,
    (c) => `<V${c.charCodeAt(0) - 0xe000}>`,
  );
const isList = (n: unknown) =>
  SlateElement.isElement(n) &&
  (n.type === "bulleted-list" || n.type === "numbered-list");

// ---------------------------------------------------------------------------
// Shape: the canonical list contract from ui/CLAUDE.md, checked through parents
// ---------------------------------------------------------------------------

export function strictShape(editor: Editor): string[] {
  const out = new Set<string>();
  const walk = (n: Descendant, parent: { type?: string } | null) => {
    if (!SlateElement.isElement(n)) return;
    const pt = parent?.type ?? "root";
    if (
      n.type === "list-item" &&
      pt !== "bulleted-list" &&
      pt !== "numbered-list"
    ) {
      out.add(`item-in-${pt}`);
    }
    if (isList(n)) {
      if (n.children.length === 0) out.add("empty-list");
      for (const c of n.children) {
        if (!(SlateElement.isElement(c) && c.type === "list-item")) {
          out.add("list-child-not-item");
        }
      }
    }
    if (n.type === "list-item") {
      const first = n.children[0];
      if (!first || !SlateElement.isElement(first)) out.add("item-text-child");
      else if (first.type !== "paragraph") out.add(`item-first-${first.type}`);
    }
    if (
      (n.type === "table-cell" || n.type === "table-row") &&
      pt !== "table" &&
      pt !== "table-row"
    ) {
      out.add(`${n.type}-in-${pt}`);
    }
    if (n.type === "paragraph" || n.type === "heading") {
      for (const c of n.children) {
        if (SlateElement.isElement(c) && !editor.isInline(c)) {
          out.add(`block-in-${n.type}`);
        }
      }
    }
    for (const c of n.children) walk(c, n);
  };
  for (const n of editor.children) walk(n, null);
  const s = editor.selection;
  if (s) {
    for (const pt of [s.anchor, s.focus]) {
      if (!Editor.hasPath(editor, pt.path)) out.add("selection-bad-path");
      else {
        const leaf = Node.get(editor, pt.path) as { text?: string };
        if (typeof leaf.text !== "string") out.add("selection-not-text");
        else if (pt.offset > leaf.text.length) out.add("selection-bad-offset");
      }
    }
  }
  return [...out].sort();
}

/** Adjacent same-type sibling lists anywhere in the tree. */
export function adjacentLists(nodes: Descendant[]): number {
  let n = 0;
  const walk = (children: Descendant[]) => {
    children.forEach((c, i) => {
      const prev = children[i - 1];
      if (
        isList(c) &&
        prev &&
        SlateElement.isElement(prev) &&
        SlateElement.isElement(c)
      ) {
        if (prev.type === c.type) n++;
      }
      if (SlateElement.isElement(c)) walk(c.children);
    });
  };
  walk(nodes);
  return n;
}

// ---------------------------------------------------------------------------
// Metadata: properties and block ids are user content
// ---------------------------------------------------------------------------

export function metadata(nodes: Descendant[]): string[] {
  const out: string[] = [];
  const walk = (n: Descendant) => {
    if (!SlateElement.isElement(n)) return;
    const el = n as SlateElement & {
      properties?: Record<string, string>;
      blockId?: string;
    };
    for (const [k, v] of Object.entries(el.properties ?? {}))
      out.push(`${k}=${v}`);
    if (el.blockId) out.push(`^${el.blockId}`);
    for (const c of n.children) walk(c);
  };
  for (const n of nodes) walk(n);
  return out.sort();
}

const without = (have: string[], take: string[]) => {
  const left = [...have];
  for (const t of take) {
    const i = left.indexOf(t);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
};

// ---------------------------------------------------------------------------
// Paste model
// ---------------------------------------------------------------------------

export interface Want {
  depth: number | null;
  kind: string | null;
  text: string;
  checked: boolean | null | undefined;
}

const fragmentEditor = (f: Descendant[]) => makeEditor(clone(f));

export function pasteClass(fragment: Descendant[]): string {
  const ls = outline(fragmentEditor(fragment));
  const lists = fragment.filter(isList);
  const kids = ls.some((l) => l.depth > 1);
  const extra = ls.some(
    (l) => l.listKey !== null && l.kind !== "b" && l.kind !== "n",
  );
  if (lists.length === 1 && fragment.length === 1) {
    if (ls.length === 1) return "list1";
    return kids ? "listKids" : extra ? "listExtra" : "listN";
  }
  if (lists.length === 0) return ls.length === 1 ? "single" : "blocks";
  return "mixed";
}

/**
 * Intended result of pasting one list at a collapsed caret on a list item's
 * lead line, as flat lines. Line 0 joins the text before the caret; later lines
 * stay at their depth relative to the host; the text after the caret joins the
 * last pasted line. Null where the design leaves it open.
 */
export function pastedListOutline(
  ls: Line[],
  lineIndex: number,
  lineOffset: number,
  fragment: Descendant[],
): Want[] | null {
  if (fragment.length !== 1 || !isList(fragment[0])) return null;
  const host = ls[lineIndex];
  if (host.kind !== "b" && host.kind !== "n") return null;
  const pasted = outline(fragmentEditor(fragment));
  if (pasted.some((l) => l.kind.endsWith("!"))) return null;
  const head = host.text.slice(0, lineOffset);
  const tail = host.text.slice(lineOffset);
  const rest: Want[] = ls.map(({ depth, kind, text, checked }) => ({
    depth,
    kind,
    text,
    checked,
  }));
  const mid: Want[] = pasted.map((l, i) => ({
    depth: host.depth + l.depth - 1,
    // A pasted top-level item may adopt the host's list type or keep its own.
    kind: l.depth === 1 && (l.kind === "b" || l.kind === "n") ? null : l.kind,
    text: l.text,
    checked: i === 0 ? undefined : l.checked,
  }));
  mid[0] = { ...mid[0], text: head + mid[0].text };
  const last = mid.length - 1;
  mid[last] = { ...mid[last], text: mid[last].text + tail };
  if (head !== "") mid[0] = { ...mid[0], checked: host.checked };
  if (mid.length > 1 && tail !== "") {
    // Whether the tail stays nested with a pasted kid is open.
    if (pasted[last].depth > 1) mid[last] = { ...mid[last], depth: null };
  }
  return [...rest.slice(0, lineIndex), ...mid, ...rest.slice(lineIndex + 1)];
}

function matches(got: Line[], want: Want[]): boolean {
  if (got.length !== want.length) return false;
  return got.every((l, i) => {
    const w = want[i];
    return (
      (w.depth === null || w.depth === l.depth) &&
      (w.kind === null || w.kind === l.kind) &&
      stripWs(l.text) === stripWs(w.text) &&
      (w.checked === undefined || w.checked === l.checked)
    );
  });
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

function pointLine(
  editor: Editor,
  ls: Line[],
  p: { path: Path; offset: number },
) {
  const saved = editor.selection;
  editor.selection = { anchor: p, focus: p };
  const c = caretInfo(editor, ls);
  editor.selection = saved;
  return c;
}

function hostFeature(editor: Editor, ls: Line[]): string {
  const s = editor.selection;
  if (!s) return "nosel";
  if (Range.isExpanded(s)) {
    const a = pointLine(editor, ls, s.anchor);
    const b = pointLine(editor, ls, s.focus);
    if (!a || !b) return "range-unresolved";
    if (a.lineIndex === b.lineIndex) return "range-1line";
    const [lo, hi] = [a.lineIndex, b.lineIndex].sort((x, y) => x - y);
    const depths = new Set(ls.slice(lo, hi + 1).map((l) => l.depth));
    return depths.size > 1 ? "range-depths" : "range-flat";
  }
  const c = caretInfo(editor, ls);
  if (!c) return "caret-unresolved";
  const l = ls[c.lineIndex];
  const pos =
    l.text.length === 0
      ? "empty"
      : c.lineOffset === 0
        ? "start"
        : c.lineOffset === l.text.length
          ? "end"
          : "mid";
  const next = ls[c.lineIndex + 1];
  const kids = next !== undefined && next.depth > l.depth;
  const where =
    l.listKey === null
      ? l.depth === 0
        ? "para"
        : "quote"
      : l.nested
        ? "nested"
        : "top";
  const lead =
    l.kind === "b" || l.kind === "n"
      ? "lead"
      : l.listKey === null
        ? ""
        : "extra";
  return [where, lead, pos, kids ? "kids" : ""].filter(Boolean).join("/");
}

function inCodeBlock(editor: Editor): boolean {
  if (!editor.selection) return false;
  const [m] = Editor.nodes(editor, {
    at: editor.selection,
    match: (n) => SlateElement.isElement(n) && n.type === "code-block",
  });
  return !!m;
}

function selectedSpan(editor: Editor, ls: Line[]): [number, number] | null {
  const s = editor.selection;
  if (!s || !Range.isExpanded(s)) return null;
  const [start, end] = Range.edges(s);
  const a = pointLine(editor, ls, start);
  const b = pointLine(editor, ls, end);
  return a && b ? [a.readingIndex, b.readingIndex] : null;
}

function selectedLines(editor: Editor, ls: Line[]): [number, number] | null {
  const s = editor.selection;
  if (!s) return null;
  const [start, end] = Range.edges(s);
  const a = pointLine(editor, ls, start);
  const b = pointLine(editor, ls, end);
  if (!a || !b) return null;
  // applySelectionList leaves a line out when the selection ends at its start.
  const last =
    b.lineOffset === 0 && b.lineIndex > a.lineIndex
      ? b.lineIndex - 1
      : b.lineIndex;
  return [a.lineIndex, last];
}

function reloadStable(children: Descendant[]): boolean {
  try {
    return json(comparable(reload(children))) === json(comparable(children));
  } catch {
    return false;
  }
}

const JUDGED = new Set([
  "pasteMd",
  "pasteFrag",
  "selList",
  "slashApply",
  "prop",
  "propClear",
  "check",
]);

export interface Coverage {
  ops: Record<string, number>;
  oracle: Record<string, number>;
  host: Record<string, number>;
}

export const newCoverage = (): Coverage => ({ ops: {}, oracle: {}, host: {} });
const bump = (r: Record<string, number>, k: string) => {
  r[k] = (r[k] ?? 0) + 1;
};

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export async function replayPaste(
  start: Descendant[],
  ops: PasteOp[],
  cov: Coverage = newCoverage(),
): Promise<{ violations: Violation[]; editor: Editor }> {
  const out: Violation[] = [];
  const editor = makeEditor(start);
  const startSnap = clone(editor.children);
  const add = (sig: string, detail: string, step: number) =>
    out.push({ sig, detail, step });
  const h = editor as HistoryEditor;
  Transforms.select(editor, Editor.start(editor, []));
  editor.history = { undos: [], redos: [] };
  await tick();
  let clip: Descendant[] | null = null;
  let undoAll = true;
  let sawBadShape = false;

  for (let step = 0; step < ops.length; step++) {
    const op = ops[step];
    bump(cov.ops, op.k);
    const judged = JUDGED.has(op.k);
    const ls = outline(editor);
    const preKids = clone(editor.children);
    const preSel = clone(editor.selection);
    const rawCaret =
      editor.selection && Range.isCollapsed(editor.selection)
        ? caretInfo(editor, ls)
        : null;
    // A list-first item's `!` line is the ancestor of everything in the item, so
    // a caret there has no reliable reading index. No caret oracle judges it.
    const caret =
      rawCaret && ls[rawCaret.lineIndex].kind.endsWith("!") ? null : rawCaret;
    const span = selectedSpan(editor, ls);
    const pre = readingOrder(ls);
    const feat = hostFeature(editor, ls);
    const preShape = strictShape(editor);
    const preStable = judged ? reloadStable(preKids) : false;
    const preAdjacent = adjacentLists(preKids);
    const undosBefore = h.history.undos.length;
    const code = inCodeBlock(editor);
    const lineSpan =
      op.k === "selList" &&
      editor.selection &&
      Range.isExpanded(editor.selection)
        ? selectedLines(editor, ls)
        : null;

    let fragment: Descendant[] | null = null;
    let cls = "";
    if (op.k === "pasteMd") fragment = markdownToSlate(op.md);
    if (op.k === "pasteFrag") fragment = clip;
    if (fragment) cls = pasteClass(fragment);
    const tag = cls ? `${op.k}/${cls}` : op.k;
    if (judged) bump(cov.host, `${tag}:${feat}`);

    // The delete half of a paste over a selection has its own known bugs (C7).
    let viaDelete = "";
    if (fragment && span) {
      const d = makeEditor(preKids);
      d.selection = clone(preSel);
      Transforms.delete(d);
      const dShape = strictShape(d);
      if (dShape.length > preShape.length) viaDelete = "via-delete:";
    }

    if (
      op.k === "copy" &&
      editor.selection &&
      Range.isExpanded(editor.selection)
    ) {
      clip = clone(editor.getFragment());
    }
    try {
      applyPasteOp(editor, op);
    } catch (e) {
      const cause = /no end text node/.test(String(e)) ? ":no-end-text" : "";
      add(
        `throw:${tag}:${feat}${cause}`,
        `${String(e)} doc=${json(editor.children)}`,
        step,
      );
      undoAll = false;
      break;
    }
    await tick();
    if (!judged) continue;
    if (op.k === "pasteFrag" && !fragment) continue;

    const post = outline(editor);
    const postReading = readingOrder(post);
    const changed = json(preKids) !== json(editor.children);

    // Shape
    bump(cov.oracle, "shape");
    const sv = strictShape(editor).filter((v) => !preShape.includes(v));
    for (const v of sv)
      add(`${viaDelete}shape:${tag}:${feat}:${v}`, json(editor.children), step);
    // Failures downstream of a broken shape are that shape's, not new ones.
    const follow = strictShape(editor).length > 0 ? "after-shape:" : viaDelete;
    if (strictShape(editor).length > 0) sawBadShape = true;

    // Reading order
    let wantReading: string | null = null;
    if (fragment) {
      // Empty plain text falls through to the rich path in withMarkdownPaste.
      const literal = code
        ? op.k === "pasteMd"
          ? op.md
          : fragment.map((n) => Node.string(n)).join("\n")
        : "";
      const pasted = literal || readingOrder(outline(fragmentEditor(fragment)));
      if (caret) {
        wantReading =
          pre.slice(0, caret.readingIndex) +
          pasted +
          pre.slice(caret.readingIndex);
      } else if (span) {
        wantReading = pre.slice(0, span[0]) + pasted + pre.slice(span[1]);
      }
    } else if (op.k === "selList") {
      wantReading = pre;
    } else if (op.k === "slashApply") {
      // A caret outside a paragraph leaves the menu closed: no conversion ran.
      if (!changed) wantReading = pre;
      else if (caret) {
        wantReading =
          pre.slice(0, caret.readingIndex - 1) + pre.slice(caret.readingIndex);
      }
    } else {
      wantReading = pre;
    }
    if (wantReading !== null) {
      bump(cov.oracle, "reading");
      if (stripWs(wantReading) !== stripWs(postReading)) {
        const bag = (s: string) => [...stripWs(s)].sort().join("");
        const same = bag(wantReading) === bag(postReading);
        add(
          `${viaDelete}${same ? "reorder" : "content"}:${tag}:${feat}`,
          `want=${asciiJson(wantReading)} got=${asciiJson(postReading)} pre=${asciiJson(pre)} frag=${json(fragment)} doc=${json(editor.children)}`,
          step,
        );
      }
    }

    // Pasted list structure, caret on a lead line
    if (fragment && caret && !code) {
      const want = pastedListOutline(
        ls,
        caret.lineIndex,
        caret.lineOffset,
        fragment,
      );
      if (want) {
        bump(cov.oracle, "pasteOutline");
        if (!matches(post, want)) {
          add(
            `${follow}outline:${tag}:${feat}`,
            `want=${json(want)} got=${json(post.map((l) => `${l.depth}${l.kind}:${l.text}`))}`,
            step,
          );
        }
      }
      // An empty top-level paragraph is the plain case: exactly what was pasted.
      const host = ls[caret.lineIndex];
      if (
        host.listKey === null &&
        host.depth === 0 &&
        host.kind === "p" &&
        host.text === "" &&
        !isPlainInline(fragment)
      ) {
        bump(cov.oracle, "pasteEmptyPara");
        // A trailing empty paragraph is the document rule's, not the fragment's.
        const wanted = outline(fragmentEditor(fragment)).filter(
          (l, i, all) =>
            !(i === all.length - 1 && l.kind === "p" && l.text === ""),
        );
        const got = post.slice(
          caret.lineIndex,
          caret.lineIndex + wanted.length,
        );
        const same = wanted.every(
          (l, i) =>
            got[i] &&
            got[i].depth === l.depth &&
            got[i].kind === l.kind &&
            got[i].text === l.text &&
            got[i].checked === l.checked,
        );
        if (!same) {
          add(
            `empty-para:${tag}`,
            `want=${json(wanted.map((l) => l.text))} got=${json(got.map((l) => l.text))}`,
            step,
          );
        }
      }
      // Caret lands after what was pasted, with the tail still ahead of it.
      if (
        wantReading !== null &&
        stripWs(wantReading) === stripWs(postReading)
      ) {
        bump(cov.oracle, "caretAfter");
        const pastedLen = stripWs(
          readingOrder(outline(fragmentEditor(fragment))),
        ).length;
        const after = editor.selection ? caretInfo(editor, post) : null;
        const wantIdx =
          stripWs(pre.slice(0, caret.readingIndex)).length + pastedLen;
        if (after) {
          const gotIdx =
            stripWs(postReading.slice(0, 0)).length +
            stripWs(readingUpTo(post, after)).length;
          const inVoid =
            editor.selection &&
            Editor.void(editor, { at: editor.selection.anchor });
          if (inVoid) {
            add(
              `${follow}caret-in-void:${tag}:${feat}`,
              json(editor.selection),
              step,
            );
          } else if (gotIdx !== wantIdx) {
            add(
              `${follow}caret:${tag}:${feat}`,
              `wantIdx=${wantIdx} gotIdx=${gotIdx} sel=${json(editor.selection)} doc=${json(post.map((l) => l.text))}`,
              step,
            );
          }
        } else if (editor.selection) {
          add(`caret-lost:${tag}:${feat}`, json(editor.selection), step);
        }
      }
    }

    // Metadata: what was there and what was pasted both survive
    if (fragment && !code) {
      bump(cov.oracle, "metadata");
      const preMeta = metadata(preKids);
      const pastedMeta = metadata(fragment);
      const postMeta = metadata(editor.children);
      const lostPasted = without(pastedMeta, without(postMeta, preMeta));
      if (lostPasted.length) {
        add(
          `meta-pasted-lost:${tag}:${feat}`,
          `lost=${json(lostPasted)} now=${json(postMeta)}`,
          step,
        );
      }
      if (!span) {
        const lostOwn = without(preMeta, postMeta);
        if (lostOwn.length)
          add(`meta-host-lost:${tag}:${feat}`, `lost=${json(lostOwn)}`, step);
      }
    }

    // Selection list: lines outside the selection keep everything, lines in it
    // become items of the list type; applying it again changes nothing.
    if (op.k === "selList" && lineSpan) {
      bump(cov.oracle, "selList");
      const preTexts = ls.map((l) => l.text);
      const softBreaks = preTexts.some((t) => t.includes("\n"));
      const [lo, hi] = lineSpan;
      const leadKind = op.list === "bulleted-list" ? "b" : "n";
      const sl = strictShape(editor).length > 0 ? "after-shape:" : "";
      const hanging =
        preSel && Range.edges(preSel)[1].offset === 0 && lo <= hi
          ? "hanging:"
          : "";
      if (!softBreaks && post.length === ls.length) {
        post.forEach((l, i) => {
          const was = ls[i];
          if (i < lo || i > hi) {
            if (
              l.depth !== was.depth ||
              l.kind !== was.kind ||
              l.checked !== was.checked ||
              l.text !== was.text
            ) {
              add(
                `${sl}${hanging}selList-unselected:${feat}`,
                `line ${i} was=${was.depth}${was.kind}:${was.text} now=${l.depth}${l.kind}:${l.text}`,
                step,
              );
            }
          } else if (
            was.kind === "p" ||
            was.kind === "paragraph" ||
            was.kind === "heading" ||
            was.kind === "b" ||
            was.kind === "n"
          ) {
            if (l.kind !== leadKind) {
              add(
                `${sl}${hanging}selList-selected-kind:${feat}`,
                `line ${i} was=${was.depth}${was.kind}:${was.text} now=${l.depth}${l.kind}:${l.text}`,
                step,
              );
            }
            if (l.checked !== was.checked && was.checked !== null) {
              add(
                `selList-checked-lost:${feat}`,
                `line ${i} was=${json(was.checked)} now=${json(l.checked)}`,
                step,
              );
            }
          }
        });
      } else if (!softBreaks) {
        add(
          `${sl}${hanging}selList-line-count:${feat}`,
          `was=${ls.length} now=${post.length}`,
          step,
        );
      }
      const lostMeta = without(metadata(preKids), metadata(editor.children));
      if (lostMeta.length)
        add(`selList-meta-lost:${feat}`, json(lostMeta), step);
      if (adjacentLists(editor.children) > preAdjacent) {
        add(
          `selList-adjacent-lists:${feat}`,
          slateToMarkdown(clone(editor.children)),
          step,
        );
      }
      // Idempotence, judged on a copy so the history under test is untouched.
      const again = makeEditor(editor.children);
      again.selection = clone(editor.selection);
      if (again.selection && Range.isExpanded(again.selection)) {
        try {
          Editor.withoutNormalizing(again, () => {
            applyPasteOp(again, op);
          });
          if (
            json(comparable(again.children)) !==
            json(comparable(editor.children))
          ) {
            add(
              `${sl}${hanging}selList-not-idempotent:${feat}`,
              `one=${slateToMarkdown(clone(editor.children))} two=${slateToMarkdown(clone(again.children))}`,
              step,
            );
          }
        } catch (e) {
          add(`throw:selList-again:${feat}`, String(e), step);
        }
      }
    }

    if (
      op.k === "slashApply" &&
      changed &&
      adjacentLists(editor.children) > preAdjacent
    ) {
      add(
        `slash-adjacent-lists:${op.id}:${feat}`,
        slateToMarkdown(clone(editor.children)),
        step,
      );
    }

    // Property edits touch only properties.
    if (op.k === "prop" || op.k === "propClear" || op.k === "check") {
      bump(cov.oracle, "propOutline");
      const a = ls.map((l) => [l.depth, l.kind, l.text]);
      const b = post.map((l) => [l.depth, l.kind, l.text]);
      if (json(a) !== json(b))
        add(`prop-outline:${op.k}:${feat}`, `${json(a)} -> ${json(b)}`, step);
    }

    // One user action, one undo batch; undo and redo are exact.
    if (changed) {
      bump(cov.oracle, "undoStep");
      const delta = h.history.undos.length - undosBefore;
      if (delta !== 1) {
        add(`undo-batches:${tag}:${delta}`, `feat=${feat}`, step);
      } else {
        const postKids = clone(editor.children);
        h.undo();
        await tick();
        if (stable(editor.children) !== stable(preKids)) {
          add(
            `${preShape.length ? "after-shape:" : ""}undo-step:${tag}:${feat}`,
            `pre=${json(preKids)} got=${json(editor.children)}`,
            step,
          );
          undoAll = false;
          break;
        }
        h.redo();
        await tick();
        if (stable(editor.children) !== stable(postKids)) {
          add(
            `${preShape.length ? "after-shape:" : ""}redo-step:${tag}:${feat}`,
            `want=${json(postKids)} got=${json(editor.children)}`,
            step,
          );
          undoAll = false;
          break;
        }
      }
    }

    // A reload-stable document stays stable.
    if (preStable) {
      bump(cov.oracle, "reload");
      const md = slateToMarkdown(clone(editor.children));
      try {
        const back = reload(editor.children);
        if (json(comparable(back)) !== json(comparable(editor.children))) {
          const c = firstDivergence(
            comparable(editor.children),
            comparable(back),
          );
          add(
            `${follow}reload:${tag}:${feat}:${c}`,
            `md=${json(md)} back=${json(back)} now=${json(editor.children)}`,
            step,
          );
        }
      } catch (e) {
        add(`throw:reload:${tag}`, `${String(e)} md=${json(md)}`, step);
      }
    }
  }

  if (undoAll) {
    bump(cov.oracle, "undoAll");
    const dirty =
      strictShape(editor).length > 0 || sawBadShape ? "after-shape:" : "";
    const endSnap = clone(editor.children);
    let guard = 0;
    let undone = 0;
    while (h.history.undos.length > 0 && guard++ < 1000) {
      h.undo();
      undone++;
      await tick();
    }
    if (stable(editor.children) !== stable(startSnap)) {
      add(
        `${dirty}undo-all`,
        `start=${json(startSnap)} got=${json(editor.children)}`,
        ops.length,
      );
    } else {
      for (let i = 0; i < undone; i++) {
        h.redo();
        await tick();
      }
      if (stable(editor.children) !== stable(endSnap)) {
        add(
          `${dirty}redo-all`,
          `end=${json(endSnap)} got=${json(editor.children)}`,
          ops.length,
        );
      }
    }
  }
  return { violations: out, editor };
}

function isPlainInline(f: Descendant[]) {
  return (
    f.length === 1 && SlateElement.isElement(f[0]) && f[0].type === "paragraph"
  );
}

function readingUpTo(ls: Line[], c: { lineIndex: number; lineOffset: number }) {
  return (
    ls
      .slice(0, c.lineIndex)
      .map((l) => l.text)
      .join("") + ls[c.lineIndex].text.slice(0, c.lineOffset)
  );
}

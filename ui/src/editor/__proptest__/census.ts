/** Replays one generated case against every oracle, recording violations. */
import { type Descendant, Editor, Range, Transforms } from "slate";
import type { HistoryEditor } from "slate-history";
import { slateToMarkdown } from "../convert";
import {
  applyOp,
  canonical,
  caretInfo,
  comparable,
  clone,
  type Line,
  makeEditor,
  type Op,
  outline,
  readingOrder,
  reload,
  shapeViolations,
  stripWs,
  tick,
} from "./harness";
import { expectedOutline, expectedReading, flat, sameOutline } from "./oracles";

export interface Violation {
  sig: string;
  detail: string;
  step: number;
}

const json = (v: unknown) => JSON.stringify(v);

function selectedSpan(editor: Editor, ls: Line[]): [number, number] | null {
  const s = editor.selection;
  if (!s || !Range.isExpanded(s)) return null;
  const [start, end] = Range.edges(s);
  const a = pointReading(editor, ls, start);
  const b = pointReading(editor, ls, end);
  return a === null || b === null ? null : [a, b];
}

function pointReading(
  editor: Editor,
  ls: Line[],
  p: { path: number[]; offset: number },
): number | null {
  const saved = editor.selection;
  editor.selection = { anchor: p, focus: p };
  const c = caretInfo(editor, ls);
  editor.selection = saved;
  return c?.readingIndex ?? null;
}

/** Why this state matters, in words stable enough to group failures by. */
function features(ls: Line[], editor: Editor): string {
  const s = editor.selection;
  if (!s) return "nosel";
  if (Range.isExpanded(s)) {
    const a = caretLine(editor, ls, s.anchor);
    const b = caretLine(editor, ls, s.focus);
    return a === b ? "range-1line" : "range-multi";
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
  const parts = [
    l.listKey === null ? "para" : l.nested ? "nested" : "top",
    l.kind === "b" || l.kind === "n" ? "lead" : "extra",
    pos,
  ];
  if (kids) parts.push("kids");
  if (l.text.length > 0 && /^[-\s]+$/.test(l.text)) {
    parts.push("voidonly");
  }
  return parts.join("/");
}

function caretLine(
  editor: Editor,
  ls: Line[],
  p: { path: number[]; offset: number },
): number | null {
  const saved = editor.selection;
  editor.selection = { anchor: p, focus: p };
  const c = caretInfo(editor, ls);
  editor.selection = saved;
  return c?.lineIndex ?? null;
}

const CARET_KEPT = new Set(["tab", "untab", "up", "down", "toggle"]);

export async function replay(
  start: Descendant[],
  ops: Op[],
  opts: { stepUndo?: boolean; reloadEvery?: boolean } = {},
): Promise<{ violations: Violation[]; editor: Editor }> {
  const out: Violation[] = [];
  const editor = makeEditor(start);
  const startSnap = clone(editor.children);
  const add = (sig: string, detail: string, step: number) =>
    out.push({ sig, detail, step });

  // The shape check judges edits, so a shape the generator seeded is ignored.
  const seeded = shapeViolations(editor);
  if (seeded.length) add(`start-shape:${seeded[0]}`, json(startSnap), -1);

  // A live editor always has a caret; history starts from one.
  Transforms.select(editor, Editor.start(editor, []));
  editor.history = { undos: [], redos: [] };
  await tick();
  let undoAll = true;
  for (let step = 0; step < ops.length; step++) {
    const op = ops[step];
    const ls = outline(editor);
    const preKids = clone(editor.children);
    const preSel = clone(editor.selection);
    const caret = caretInfo(editor, ls);
    const span = selectedSpan(editor, ls);
    const pre = readingOrder(ls);
    const feat = features(ls, editor);
    const h = editor as HistoryEditor;
    const undosBefore = h.history.undos.length;
    try {
      applyOp(editor, op);
    } catch (e) {
      add(`throw:${op.k}:${feat}`, String(e), step);
      undoAll = false;
      break;
    }
    await tick();
    if (op.k === "caret" || op.k === "range") continue;
    if (op.k === "undo" || op.k === "redo") {
      const sv = shapeViolations(editor);
      if (sv.length) add(`shape:${op.k}:${sv[0]}`, json(editor.children), step);
      continue;
    }

    const post = outline(editor);
    const postReading = readingOrder(post);

    const sv = shapeViolations(editor);
    if (sv.length && shapeViolations(makeEditorLike(preKids)).length === 0) {
      add(`shape:${op.k}:${feat}:${sv[0]}`, json(editor.children), step);
    }

    const ch = op.k === "type" ? op.ch : undefined;
    const wantReading = expectedReading(op.k, pre, caret, span, ch);
    if (wantReading !== null && stripWs(wantReading) !== stripWs(postReading)) {
      const bagSame =
        [...stripWs(wantReading)].sort().join("") ===
        [...stripWs(postReading)].sort().join("");
      add(
        `${bagSame ? "reorder" : "content"}:${op.k}:${feat}`,
        `want=${json(wantReading)} got=${json(postReading)}`,
        step,
      );
    }

    if (caret && !span) {
      const want = expectedOutline(op.k, ls, caret);
      if (want && !sameOutline(flat(post), want)) {
        add(
          `outline:${op.k}:${feat}`,
          `want=${json(want)} got=${json(flat(post))}`,
          step,
        );
      }
      if (CARET_KEPT.has(op.k)) {
        const after = caretInfo(editor, post);
        const same =
          after &&
          post[after.lineIndex].text === ls[caret.lineIndex].text &&
          after.lineOffset === caret.lineOffset;
        if (!same) {
          add(`caret:${op.k}:${feat}`, json({ preSel, sel: editor.selection }), step);
        }
      }
    }

    // Undo of one batch restores exactly the state before it; redo the state after.
    if (opts.stepUndo && h.history.undos.length === undosBefore + 1) {
      const postKids = clone(editor.children);
      h.undo();
      await tick();
      if (json(editor.children) !== json(preKids)) {
        add(`undo-step:${op.k}:${feat}`, `pre=${json(preKids)} got=${json(editor.children)}`, step);
        undoAll = false;
        break;
      }
      h.redo();
      await tick();
      if (json(editor.children) !== json(postKids)) {
        add(`redo-step:${op.k}:${feat}`, `want=${json(postKids)} got=${json(editor.children)}`, step);
        undoAll = false;
        break;
      }
    }

    if (opts.reloadEvery !== false) {
      const md = slateToMarkdown(clone(editor.children));
      let back: Descendant[] | null = null;
      try {
        back = reload(editor.children);
      } catch (e) {
        add(`throw:reload:${op.k}`, `${String(e)} md=${json(md)}`, step);
      }
      const preStable = reloadStable(preKids);
      if (
        preStable &&
        back &&
        json(comparable(back)) !== json(comparable(editor.children))
      ) {
        const cls = firstDivergence(comparable(editor.children), comparable(back));
        add(
          `reload:${cls}:${op.k}`,
          `feat=${feat} md=${json(md)} now=${json(canonical(editor.children))} back=${json(canonical(back))}`,
          step,
        );
      }
      if (back) {
        const md2 = slateToMarkdown(clone(back));
        const hasTopEmpty =
          json(comparable(editor.children)) !==
          json(canonical(editor.children));
        if (preStable && !hasTopEmpty && md2 !== md) {
          add(`md-unstable:${op.k}`, `md=${json(md)} md2=${json(md2)}`, step);
        }
      }
    }
  }

  // Whole history: start snapshot and end snapshot are both reachable.
  if (undoAll) {
    const h = editor as HistoryEditor;
    const endSnap = clone(editor.children);
    let guard = 0;
    let undone = 0;
    while (h.history.undos.length > 0 && guard++ < 1000) {
      h.undo();
      undone++;
      await tick();
    }
    if (json(editor.children) !== json(startSnap)) {
      add("undo-all", `start=${json(startSnap)} got=${json(editor.children)}`, ops.length);
    } else {
      // Redo only what was undone: an earlier explicit undo may leave more.
      for (let i = 0; i < undone; i++) {
        h.redo();
        await tick();
      }
      if (json(editor.children) !== json(endSnap)) {
        add("redo-all", `end=${json(endSnap)} got=${json(editor.children)}`, ops.length);
      }
    }
  }
  return { violations: out, editor };
}

function reloadStable(children: Descendant[]): boolean {
  try {
    return json(comparable(reload(children))) === json(comparable(children));
  } catch {
    return false;
  }
}

/** First structural difference of two canonical trees, as a coarse class. */
export function firstDivergence(a: unknown, b: unknown, ctx = "root"): string {
  if (Array.isArray(a) && Array.isArray(b)) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const d = firstDivergence(a[i], b[i], ctx);
      if (d) return d;
    }
    return a.length === b.length ? "" : `count@${ctx}:${a.length}->${b.length > a.length ? "more" : "fewer"}`;
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const x = a as Record<string, unknown>;
    const y = b as Record<string, unknown>;
    const t = String(x.type ?? (x.text !== undefined ? "text" : "?"));
    for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (k === "children") continue;
      if (json(x[k]) !== json(y[k])) return `prop:${k}@${t}`;
    }
    if (x.children || y.children) return firstDivergence(x.children, y.children, t);
    return "";
  }
  return a === b ? "" : `value@${ctx}`;
}

function makeEditorLike(children: Descendant[]) {
  return { children, selection: null } as unknown as Editor;
}

/**
 * Metamorphic: saving and reloading between two edit runs must not change the
 * final document. Coordinates are logical, so the reloaded caret is the same
 * caret if the reload kept the document.
 */
export async function continuation(
  start: Descendant[],
  prefix: Op[],
  suffix: Op[],
): Promise<Violation | null> {
  const a = makeEditor(start);
  Transforms.select(a, Editor.start(a, []));
  for (const op of prefix) {
    applyOp(a, op);
    await tick();
  }
  const ls = outline(a);
  const c = caretInfo(a, ls);
  const b = makeEditor(reload(a.children));
  // Lines must correspond one to one, or logical caret positions would not.
  if (json(canonical(b.children)) !== json(canonical(a.children))) return null;
  if (c) {
    const bl = outline(b)[c.lineIndex];
    if (bl) {
      Transforms.select(b, Editor.start(b, bl.path));
      for (let i = 0; i < c.lineOffset; i++) {
        Transforms.move(b, { distance: 1, unit: "offset" });
      }
    }
  }
  for (const op of suffix) {
    applyOp(a, op);
    await tick();
    applyOp(b, op);
    await tick();
    const ma = slateToMarkdown(clone(a.children));
    const mb = slateToMarkdown(clone(b.children));
    if (ma !== mb) {
      return {
        sig: `continuation:${op.k}`,
        detail: `live=${json(ma)} reloaded=${json(mb)}`,
        step: 0,
      };
    }
  }
  return null;
}

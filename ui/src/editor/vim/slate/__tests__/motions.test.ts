import type { Editor } from "slate";
import { describe, expect, it } from "vitest";
import type { Motion } from "../../core/ast";
import { getLines, pointOfPos, posOfPoint } from "../lines";
import { type MotionResolution, resolveMotion } from "../motions";
import { INITIAL_VIM_STATE, type VimState } from "../types";
import { code, docFrom, hr, li, makeEditor, p, t, ul } from "./fixtures";

function resolve(
  editor: Editor,
  motion: Motion,
  count: number | null = null,
  state: VimState = INITIAL_VIM_STATE,
): MotionResolution {
  const lines = getLines(editor);
  const selection = editor.selection;
  if (!selection) throw new Error("fixture has no cursor");
  const from = posOfPoint(editor, lines, selection.anchor);
  return resolveMotion(lines, from, state, motion, count);
}

function charTarget(res: MotionResolution) {
  if (res.target?.kind !== "char") throw new Error("expected char target");
  return { li: res.target.pos.li, off: res.target.pos.off };
}

function lineTarget(res: MotionResolution) {
  if (res.target?.kind !== "line") throw new Error("expected line target");
  return { li: res.target.li, off: res.target.off };
}

describe("getLines", () => {
  it("maps blocks to lines, splitting code blocks on newlines", () => {
    const editor = makeEditor(
      p("first"),
      code("alpha\nbravo\ncharlie"),
      ul(li("item")),
      hr(),
    );
    const lines = getLines(editor);
    expect(lines.map((l) => l.text)).toEqual([
      "first",
      "alpha",
      "bravo",
      "charlie",
      "item",
      "",
    ]);
    expect(lines[1].start).toBe(0);
    expect(lines[2].start).toBe(6);
    expect(lines[3].start).toBe(12);
    expect(lines[1].blockPath).toEqual(lines[3].blockPath);
  });
});

describe("posOfPoint / pointOfPos", () => {
  it("round-trips across mark-split leaves", () => {
    const editor = makeEditor(p("ab", t("cd", { bold: true }), "ef|"));
    const lines = getLines(editor);
    const selection = editor.selection;
    if (!selection) throw new Error("no cursor");
    const pos = posOfPoint(editor, lines, selection.anchor);
    expect(pos).toEqual({ li: 0, off: 6 });
    const mid = pointOfPos(editor, lines, { li: 0, off: 3 });
    expect(mid).toEqual({ path: [0, 1], offset: 1 });
    expect(posOfPoint(editor, lines, mid)).toEqual({ li: 0, off: 3 });
  });

  it("round-trips inside code-block virtual lines", () => {
    const editor = makeEditor(code("alpha\nbr|avo\ncharlie"));
    const lines = getLines(editor);
    const selection = editor.selection;
    if (!selection) throw new Error("no cursor");
    expect(posOfPoint(editor, lines, selection.anchor)).toEqual({
      li: 1,
      off: 2,
    });
    const point = pointOfPos(editor, lines, { li: 2, off: 4 });
    expect(point).toEqual({ path: [0, 0], offset: 16 });
  });
});

describe("char and line motions", () => {
  it("moves h/l with clamping", () => {
    const editor = docFrom("ab|cd");
    expect(charTarget(resolve(editor, { t: "char", dir: 1 }))).toEqual({
      li: 0,
      off: 3,
    });
    expect(charTarget(resolve(editor, { t: "char", dir: -1 }, 5))).toEqual({
      li: 0,
      off: 0,
    });
  });

  it("resolves 0, ^ and $", () => {
    const editor = docFrom("  hi there|");
    expect(charTarget(resolve(editor, { t: "line-start" }))).toEqual({
      li: 0,
      off: 0,
    });
    expect(charTarget(resolve(editor, { t: "first-nonblank" }))).toEqual({
      li: 0,
      off: 2,
    });
    const end = resolve(editor, { t: "line-end" });
    expect(charTarget(end)).toEqual({ li: 0, off: 9 });
    expect(end.target?.kind === "char" && end.target.inclusive).toBe(true);
  });

  it("tracks goal column across short lines with j", () => {
    const editor = docFrom("longer lin|e", "ab", "another long");
    const first = resolve(editor, { t: "line-vert", dir: 1 });
    expect(lineTarget(first)).toEqual({ li: 1, off: 1 });
    expect(first.patch?.goalColumn).toBe(10);
    // Continue from line 1 with the stored goal column.
    const lines = getLines(editor);
    const next = resolveMotion(
      lines,
      { li: 1, off: 1 },
      { ...INITIAL_VIM_STATE, goalColumn: 10 },
      { t: "line-vert", dir: 1 },
      null,
    );
    expect(lineTarget(next)).toEqual({ li: 2, off: 10 });
  });

  it("resolves gg, G and counted G", () => {
    const editor = docFrom("  a|", "b", "c");
    expect(lineTarget(resolve(editor, { t: "doc", edge: "last" }))).toEqual({
      li: 2,
      off: 0,
    });
    expect(lineTarget(resolve(editor, { t: "doc", edge: "first" }))).toEqual({
      li: 0,
      off: 2,
    });
    expect(lineTarget(resolve(editor, { t: "doc", edge: "last" }, 2))).toEqual({
      li: 1,
      off: 0,
    });
  });
});

describe("word motions", () => {
  it("moves w/e/b within a line", () => {
    const editor = docFrom("|one two three");
    expect(charTarget(resolve(editor, { t: "word", kind: "w" }))).toEqual({
      li: 0,
      off: 4,
    });
    expect(charTarget(resolve(editor, { t: "word", kind: "w" }, 2))).toEqual({
      li: 0,
      off: 8,
    });
    expect(charTarget(resolve(editor, { t: "word", kind: "e" }))).toEqual({
      li: 0,
      off: 2,
    });
  });

  it("treats punctuation as separate words", () => {
    const editor = docFrom("|foo.bar");
    expect(charTarget(resolve(editor, { t: "word", kind: "w" }))).toEqual({
      li: 0,
      off: 3,
    });
    expect(charTarget(resolve(editor, { t: "word", kind: "w" }, 2))).toEqual({
      li: 0,
      off: 4,
    });
  });

  it("crosses block boundaries", () => {
    const editor = docFrom("on|e", "two");
    expect(charTarget(resolve(editor, { t: "word", kind: "w" }))).toEqual({
      li: 1,
      off: 0,
    });
    const back = docFrom("one", "|two");
    expect(charTarget(resolve(back, { t: "word", kind: "b" }))).toEqual({
      li: 0,
      off: 0,
    });
  });

  it("stops on empty lines for w but not e", () => {
    const editor = docFrom("on|e", "", "two");
    expect(charTarget(resolve(editor, { t: "word", kind: "w" }))).toEqual({
      li: 1,
      off: 0,
    });
    expect(charTarget(resolve(editor, { t: "word", kind: "e" }))).toEqual({
      li: 2,
      off: 2,
    });
  });

  it("clamps at the document end", () => {
    // Raw target may sit one past the last char (so dw eats it);
    // plain moves clamp back to the char at execution time.
    const editor = docFrom("one tw|o");
    expect(charTarget(resolve(editor, { t: "word", kind: "w" }, 5))).toEqual({
      li: 0,
      off: 7,
    });
  });
});

describe("find motions", () => {
  it("resolves f and t with counts", () => {
    const editor = docFrom("|xzbzb");
    const f = resolve(editor, { t: "find", kind: "f", char: "b" });
    expect(charTarget(f)).toEqual({ li: 0, off: 2 });
    expect(f.patch?.lastFind).toEqual({ kind: "f", char: "b" });
    expect(
      charTarget(resolve(editor, { t: "find", kind: "f", char: "b" }, 2)),
    ).toEqual({ li: 0, off: 4 });
    expect(
      charTarget(resolve(editor, { t: "find", kind: "t", char: "b" })),
    ).toEqual({ li: 0, off: 1 });
  });

  it("resolves F and T backward", () => {
    const editor = docFrom("xzbz|b");
    expect(
      charTarget(resolve(editor, { t: "find", kind: "F", char: "b" })),
    ).toEqual({ li: 0, off: 2 });
    expect(
      charTarget(resolve(editor, { t: "find", kind: "T", char: "b" })),
    ).toEqual({ li: 0, off: 3 });
  });

  it("fails but records lastFind when the char is missing", () => {
    const editor = docFrom("|abc");
    const res = resolve(editor, { t: "find", kind: "f", char: "q" });
    expect(res.target).toBeNull();
    expect(res.patch?.lastFind).toEqual({ kind: "f", char: "q" });
  });

  it("fails when t would not move the cursor", () => {
    const editor = docFrom("|ab");
    const res = resolve(editor, { t: "find", kind: "t", char: "b" });
    expect(res.target).toBeNull();
  });

  it("repeats with ; and reverses with ,", () => {
    const editor = docFrom("xzbz|b");
    const state: VimState = {
      ...INITIAL_VIM_STATE,
      lastFind: { kind: "F", char: "b" },
    };
    expect(
      charTarget(
        resolve(editor, { t: "repeat-find", reverse: false }, null, state),
      ),
    ).toEqual({ li: 0, off: 2 });
    const fwd = docFrom("|bzbzb");
    const fState: VimState = {
      ...INITIAL_VIM_STATE,
      lastFind: { kind: "f", char: "b" },
    };
    expect(
      charTarget(
        resolve(fwd, { t: "repeat-find", reverse: false }, null, fState),
      ),
    ).toEqual({ li: 0, off: 2 });
  });

  it("skips an adjacent target when repeating t", () => {
    // Cursor at 1 after a `tb` (sitting just before the b at 2).
    const editor = docFrom("x|zbzb");
    const state: VimState = {
      ...INITIAL_VIM_STATE,
      lastFind: { kind: "t", char: "b" },
    };
    expect(
      charTarget(
        resolve(editor, { t: "repeat-find", reverse: false }, null, state),
      ),
    ).toEqual({ li: 0, off: 3 });
  });

  it("fails repeat-find with no stored find", () => {
    const editor = docFrom("|abc");
    expect(
      resolve(editor, { t: "repeat-find", reverse: false }).target,
    ).toBeNull();
  });
});

/**
 * Vim columns must never split a grapheme: surrogate-pair emoji, combining
 * marks, and ZWJ sequences are atoms for x, r, ~, h/l, $, operators, text
 * objects, visual mode, find motions, insert entry/exit, and paste.
 */
import { describe, expect, it } from "vitest";
import { docFrom, snapshot } from "./fixtures";
import { keys } from "./helpers";

// 👨‍👩‍👧 = man + ZWJ + woman + ZWJ + girl: 8 UTF-16 code units, one grapheme.
const FAM = "\u{1F468}‍\u{1F469}‍\u{1F467}";
// é as e + combining acute: 2 code units, one grapheme.
const E = "é";

describe("x on multi-unit graphemes", () => {
  it("deletes a whole surrogate-pair emoji", () => {
    const editor = docFrom("|😀a");
    keys(editor, "x");
    expect(snapshot(editor)).toEqual(["|a"]);
  });

  it("deletes a whole ZWJ sequence", () => {
    const editor = docFrom(`|${FAM}a`);
    keys(editor, "x");
    expect(snapshot(editor)).toEqual(["|a"]);
  });

  it("deletes a whole combining-mark cluster", () => {
    const editor = docFrom(`|${E}b`);
    keys(editor, "x");
    expect(snapshot(editor)).toEqual(["|b"]);
  });

  it("2x deletes two graphemes", () => {
    const editor = docFrom("|😀😀a");
    keys(editor, "2x");
    expect(snapshot(editor)).toEqual(["|a"]);
  });
});

describe("h/l over graphemes", () => {
  it("l steps over an emoji, x then deletes what follows", () => {
    const editor = docFrom("|😀a");
    keys(editor, "lx");
    // The caret clamps back onto the emoji (vim's end-of-line rule).
    expect(snapshot(editor)).toEqual(["|😀"]);
  });

  it("h steps back over an emoji", () => {
    const editor = docFrom("😀|a");
    keys(editor, "hx");
    expect(snapshot(editor)).toEqual(["|a"]);
  });
});

describe("r and ~", () => {
  it("r replaces a whole emoji with the typed char", () => {
    const editor = docFrom("|😀b");
    keys(editor, "rx");
    expect(snapshot(editor)).toEqual(["|xb"]);
  });

  it("~ advances over an emoji without splitting it", () => {
    const editor = docFrom("|a😀b");
    keys(editor, "~~~");
    expect(snapshot(editor)).toEqual(["A😀|B"]);
  });
});

describe("$ and goal column", () => {
  it("$ lands on the last grapheme", () => {
    const editor = docFrom("|a😀");
    keys(editor, "$x");
    expect(snapshot(editor)).toEqual(["|a"]);
  });

  it("j snaps a mid-grapheme goal column to a boundary", () => {
    const editor = docFrom("a|bcd", "😀x");
    keys(editor, "j");
    expect(snapshot(editor)).toEqual(["abcd", "|😀x"]);
  });
});

describe("operators and text objects", () => {
  it("dw deletes an emoji run without splitting pairs", () => {
    const editor = docFrom("|😀😀 b");
    keys(editor, "dw");
    expect(snapshot(editor)).toEqual(["|b"]);
  });

  it("cw treats a combining cluster as part of its word", () => {
    const editor = docFrom(`|${E}x y`);
    keys(editor, "cw");
    expect(snapshot(editor)).toEqual(["| y"]);
  });

  it("diw sees a word containing a combining cluster as one run", () => {
    const editor = docFrom(`a|${E}b c`);
    keys(editor, "diw");
    expect(snapshot(editor)).toEqual(["| c"]);
  });
});

describe("find motions", () => {
  it("t stops on the whole grapheme before the target", () => {
    const editor = docFrom("|a😀bc");
    keys(editor, "tbx");
    expect(snapshot(editor)).toEqual(["a|bc"]);
  });

  it("f does not match the base letter inside a cluster", () => {
    const editor = docFrom(`|a${E}xex`);
    keys(editor, "fex");
    expect(snapshot(editor)).toEqual([`a${E}x|x`]);
  });
});

describe("visual mode", () => {
  it("v + d deletes the whole emoji under the cursor", () => {
    const editor = docFrom("|😀a");
    keys(editor, "vd");
    expect(snapshot(editor)).toEqual(["|a"]);
  });

  it("v + 2l + d spans graphemes", () => {
    const editor = docFrom("|a😀b");
    keys(editor, "v2ld");
    expect(snapshot(editor)).toEqual(["|"]);
  });
});

describe("insert entry and exit", () => {
  it("a positions the caret after the whole emoji", () => {
    const editor = docFrom("|😀a");
    keys(editor, "a");
    expect(snapshot(editor)).toEqual(["😀|a"]);
  });

  it("Escape from insert steps back one grapheme", () => {
    const editor = docFrom("|a😀");
    keys(editor, "A<Esc>");
    expect(snapshot(editor)).toEqual(["a|😀"]);
  });
});

describe("charwise yank and paste", () => {
  it("yl captures the whole grapheme and p pastes after it", () => {
    const editor = docFrom("|😀b");
    keys(editor, "ylp");
    expect(snapshot(editor)).toEqual(["😀|😀b"]);
  });
});

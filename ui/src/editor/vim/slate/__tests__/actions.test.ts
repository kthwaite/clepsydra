import { describe, expect, it } from "vitest";
import { code, docFrom, li, makeEditor, snapshot, ul } from "./fixtures";
import { INITIAL_VIM_STATE, type VimState } from "../types";
import { keys } from "./helpers";

describe("x", () => {
  it("deletes the char under the cursor", () => {
    const editor = docFrom("ab|cd");
    keys(editor, "x");
    expect(snapshot(editor)).toEqual(["ab|d"]);
  });

  it("clamps a counted delete at end of line", () => {
    const editor = docFrom("ab|cd");
    keys(editor, "3x");
    expect(snapshot(editor)).toEqual(["a|b"]);
  });

  it("no-ops on an empty line", () => {
    const editor = docFrom("|");
    keys(editor, "x");
    expect(snapshot(editor)).toEqual(["|"]);
  });
});

describe("r", () => {
  it("replaces the char under the cursor", () => {
    const editor = docFrom("ab|cd");
    keys(editor, "rz");
    expect(snapshot(editor)).toEqual(["ab|zd"]);
  });

  it("replaces count chars and lands on the last", () => {
    const editor = docFrom("|abcd");
    keys(editor, "3rz");
    expect(snapshot(editor)).toEqual(["zz|zd"]);
  });

  it("aborts when fewer than count chars remain", () => {
    const editor = docFrom("ab|cd");
    keys(editor, "3rz");
    expect(snapshot(editor)).toEqual(["ab|cd"]);
  });
});

describe("~", () => {
  it("toggles case and advances", () => {
    const editor = docFrom("a|bc");
    keys(editor, "~");
    expect(snapshot(editor)).toEqual(["aB|c"]);
  });

  it("toggles count chars, clamping at end of line", () => {
    const editor = docFrom("a|bC");
    keys(editor, "5~");
    expect(snapshot(editor)).toEqual(["aB|c"]);
  });
});

describe("J", () => {
  it("joins with a single space, stripping leading whitespace", () => {
    const editor = docFrom("ab|", "   cd");
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["ab| cd"]);
  });

  it("joins an empty next line without adding a space", () => {
    const editor = docFrom("ab|", "", "cd");
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["a|b", "cd"]);
  });

  it("joins count lines", () => {
    const editor = docFrom("a|", "b", "c");
    keys(editor, "3J");
    expect(snapshot(editor)).toEqual(["a b| c"]);
  });

  it("no-ops on the last line", () => {
    const editor = docFrom("a", "b|");
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["a", "b|"]);
  });

  it("joins virtual lines inside a code block", () => {
    const editor = makeEditor(code("a|a\n  bb"));
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["code:aa| bb"]);
  });
});

describe("insert entry", () => {
  function mode(state: VimState) {
    return state.mode;
  }

  it("i keeps the caret in place", () => {
    const editor = docFrom("a|b");
    expect(mode(keys(editor, "i"))).toBe("insert");
    expect(snapshot(editor)).toEqual(["a|b"]);
  });

  it("a moves one right (allowed past the last char)", () => {
    const editor = docFrom("a|b");
    keys(editor, "a");
    expect(snapshot(editor)).toEqual(["ab|"]);
  });

  it("I goes to the first non-blank", () => {
    const editor = docFrom("  ab|");
    keys(editor, "I");
    expect(snapshot(editor)).toEqual(["  |ab"]);
  });

  it("A goes past the end of line", () => {
    const editor = docFrom("a|b  ");
    keys(editor, "A");
    expect(snapshot(editor)).toEqual(["ab  |"]);
  });

  it("o opens a line below", () => {
    const editor = docFrom("ab|c", "z");
    const state = keys(editor, "o");
    expect(state.mode).toBe("insert");
    expect(snapshot(editor)).toEqual(["abc", "|", "z"]);
  });

  it("O opens a line above", () => {
    const editor = docFrom("ab|c");
    keys(editor, "O");
    expect(snapshot(editor)).toEqual(["|", "abc"]);
  });

  it("o continues a list", () => {
    const editor = makeEditor(ul(li("it|em"), li("last")));
    keys(editor, "o");
    expect(snapshot(editor)).toEqual(["li:item", "li:|", "li:last"]);
  });

  it("o inside a code block opens a line within the block", () => {
    const editor = makeEditor(code("a|a\nbb"));
    keys(editor, "o");
    expect(snapshot(editor)).toEqual(["code:aa\n|\nbb"]);
  });

  it("O inside a code block opens a line above within the block", () => {
    const editor = makeEditor(code("aa\nb|b"));
    keys(editor, "O");
    expect(snapshot(editor)).toEqual(["code:aa\n|\nbb"]);
  });
});

describe("escape", () => {
  it("steps the caret one left when leaving insert mode", () => {
    const editor = docFrom("ab|");
    const state = keys(editor, "<Esc>", {
      ...INITIAL_VIM_STATE,
      mode: "insert" as const,
    });
    expect(state.mode).toBe("normal");
    expect(snapshot(editor)).toEqual(["a|b"]);
  });

  it("does not go past the line start", () => {
    const editor = docFrom("|ab");
    keys(editor, "<Esc>", { ...INITIAL_VIM_STATE, mode: "insert" as const });
    expect(snapshot(editor)).toEqual(["|ab"]);
  });
});

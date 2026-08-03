import { describe, expect, it } from "vitest";
import { code, docFrom, makeEditor, snapshot } from "./fixtures";
import { keys } from "./helpers";

describe("visual charwise", () => {
  it("selects the char under the cursor on entry", () => {
    const editor = docFrom("a|bc");
    const state = keys(editor, "v");
    expect(state.mode).toBe("visual");
    expect(snapshot(editor)).toEqual(["a⟨b⟩c"]);
  });

  it("extends with motions (inclusive both ends)", () => {
    const editor = docFrom("a|bcde");
    keys(editor, "v2l");
    expect(snapshot(editor)).toEqual(["a⟨bcd⟩e"]);
  });

  it("extends backward keeping the anchor char selected", () => {
    const editor = docFrom("abc|de");
    keys(editor, "vh");
    // Backward selection: focus (⟩) before anchor (⟨); c and d selected.
    expect(snapshot(editor)).toEqual(["ab⟩cd⟨e"]);
  });

  it("deletes the selection with d and returns to normal", () => {
    const editor = docFrom("a|bcde");
    const state = keys(editor, "v2ld");
    expect(state.mode).toBe("normal");
    expect(snapshot(editor)).toEqual(["a|e"]);
  });

  it("x acts like d on the selection", () => {
    const editor = docFrom("a|bcde");
    keys(editor, "vlx");
    expect(snapshot(editor)).toEqual(["a|de"]);
  });

  it("changes the selection with c into insert mode", () => {
    const editor = docFrom("a|bcde");
    const state = keys(editor, "vlc");
    expect(state.mode).toBe("insert");
    expect(snapshot(editor)).toEqual(["a|de"]);
  });

  it("yanks the selection and pastes it", () => {
    const editor = docFrom("a|bcde");
    keys(editor, "vlyP");
    // "bc" yanked, caret back at start, P pastes before the cursor.
    expect(snapshot(editor)).toEqual(["ab|cbcde"]);
  });

  it("spans lines", () => {
    const editor = docFrom("ab|c", "def");
    keys(editor, "vjd");
    // Selects c (goal column keeps off 2) through f inclusive.
    expect(snapshot(editor)).toEqual(["a|b"]);
  });

  it("exits on a second v", () => {
    const editor = docFrom("a|bc");
    const state = keys(editor, "vlv");
    expect(state.mode).toBe("normal");
    expect(snapshot(editor)).toEqual(["ab|c"]);
  });

  it("exits on Escape at the head position", () => {
    const editor = docFrom("a|bcde");
    const state = keys(editor, "v2l<Esc>");
    expect(state.mode).toBe("normal");
    expect(snapshot(editor)).toEqual(["abc|de"]);
  });

  it("selects a text object with iw", () => {
    const editor = docFrom("one tw|o three");
    keys(editor, "viw");
    expect(snapshot(editor)).toEqual(["one ⟨two⟩ three"]);
  });

  it("deletes a selected text object", () => {
    const editor = docFrom('say "hel|lo" now');
    keys(editor, 'vi"d');
    expect(snapshot(editor)).toEqual(['say "|" now']);
  });
});

describe("visual linewise", () => {
  it("selects the whole line on entry", () => {
    const editor = docFrom("ab|c", "def");
    keys(editor, "V");
    expect(snapshot(editor)).toEqual(["⟨abc⟩", "def"]);
  });

  it("extends by lines and deletes linewise", () => {
    const editor = docFrom("a|a", "bb", "cc");
    const state = keys(editor, "Vjd");
    expect(state.mode).toBe("normal");
    expect(snapshot(editor)).toEqual(["|cc"]);
  });

  it("yanks linewise and pastes as lines", () => {
    const editor = docFrom("a|a", "bb");
    keys(editor, "Vjyp");
    expect(snapshot(editor)).toEqual(["aa", "|aa", "bb", "bb"]);
  });

  it("changes lines into a single empty line", () => {
    const editor = docFrom("a|a", "bb", "cc");
    const state = keys(editor, "Vjc");
    expect(state.mode).toBe("insert");
    expect(snapshot(editor)).toEqual(["|", "cc"]);
  });

  it("switches from charwise to linewise with V", () => {
    const editor = docFrom("ab|c", "def");
    keys(editor, "vV");
    expect(snapshot(editor)).toEqual(["⟨abc⟩", "def"]);
  });

  it("works across code-block virtual lines", () => {
    const editor = makeEditor(code("a|a\nbb\ncc"));
    keys(editor, "Vjd");
    expect(snapshot(editor)).toEqual(["code:|cc", ""]);
  });
});

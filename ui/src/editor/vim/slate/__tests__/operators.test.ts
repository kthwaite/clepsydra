import { describe, expect, it } from "vitest";
import { code, docFrom, li, makeEditor, p, snapshot, ul } from "./fixtures";
import { keys } from "./helpers";

describe("dw / de / db", () => {
  it("deletes a word with trailing space", () => {
    const editor = docFrom("one |two three");
    keys(editor, "dw");
    expect(snapshot(editor)).toEqual(["one |three"]);
  });

  it("applies counts multiplicatively", () => {
    const editor = docFrom("|one two three four");
    keys(editor, "d2w");
    expect(snapshot(editor)).toEqual(["|three four"]);
  });

  it("clips at end of line instead of eating the newline", () => {
    const editor = docFrom("one tw|o", "next");
    keys(editor, "dw");
    expect(snapshot(editor)).toEqual(["one t|w", "next"]);
  });

  it("joins lines when deleting a word from an empty line", () => {
    const editor = docFrom("|", "two");
    keys(editor, "dw");
    expect(snapshot(editor)).toEqual(["|two"]);
  });

  it("deletes backward with db", () => {
    const editor = docFrom("one two| three");
    keys(editor, "db");
    expect(snapshot(editor)).toEqual(["one | three"]);
  });
});

describe("cw", () => {
  it("changes to the end of the word without trailing space", () => {
    const editor = docFrom("o|ne two");
    const state = keys(editor, "cw");
    expect(snapshot(editor)).toEqual(["o| two"]);
    expect(state.mode).toBe("insert");
  });

  it("changes only the last char when the cursor sits on it", () => {
    const editor = docFrom("on|e two");
    keys(editor, "cw");
    expect(snapshot(editor)).toEqual(["on| two"]);
  });

  it("spans further words with a count", () => {
    const editor = docFrom("|foo bar baz");
    keys(editor, "2cw");
    expect(snapshot(editor)).toEqual(["| baz"]);
  });

  it("stops at punctuation runs", () => {
    const editor = docFrom("|foo.bar");
    keys(editor, "cw");
    expect(snapshot(editor)).toEqual(["|.bar"]);
  });
});

describe("d with line motions", () => {
  it("d$ deletes to end of line inclusively", () => {
    const editor = docFrom("abc|def");
    keys(editor, "d$");
    expect(snapshot(editor)).toEqual(["ab|c"]);
  });

  it("d0 deletes to line start", () => {
    const editor = docFrom("abc|def");
    keys(editor, "d0");
    expect(snapshot(editor)).toEqual(["|def"]);
  });

  it("dj deletes two lines linewise", () => {
    const editor = docFrom("a|a", "bb", "cc");
    keys(editor, "dj");
    expect(snapshot(editor)).toEqual(["|cc"]);
  });

  it("dG deletes to the last line", () => {
    const editor = docFrom("aa", "b|b", "cc");
    keys(editor, "dG");
    expect(snapshot(editor)).toEqual(["|aa"]);
  });

  it("dgg deletes to the first line", () => {
    const editor = docFrom("aa", "b|b", "cc");
    keys(editor, "dgg");
    expect(snapshot(editor)).toEqual(["|cc"]);
  });

  it("dfx deletes through the found char", () => {
    const editor = docFrom("|one x two");
    keys(editor, "dfx");
    expect(snapshot(editor)).toEqual(["| two"]);
  });
});

describe("dd", () => {
  it("deletes a line and lands on the first non-blank below", () => {
    const editor = docFrom("one|", "  two");
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["  |two"]);
  });

  it("moves up when deleting the last line", () => {
    const editor = docFrom("one", "tw|o");
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["|one"]);
  });

  it("repairs the editor when deleting the only line", () => {
    const editor = docFrom("on|e");
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["|"]);
  });

  it("takes a count", () => {
    const editor = docFrom("a|a", "bb", "cc");
    keys(editor, "2dd");
    expect(snapshot(editor)).toEqual(["|cc"]);
  });

  it("deletes a virtual line inside a code block", () => {
    const editor = makeEditor(code("aa\nb|b\ncc"));
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["code:aa\n|cc"]);
  });

  it("deletes the last virtual line of a code block", () => {
    const editor = makeEditor(code("aa\nb|b"));
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["code:|aa"]);
  });

  it("removes a whole list item", () => {
    const editor = makeEditor(ul(li("on|e"), li("two")));
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["li:|two"]);
  });

  it("removes the whole list when deleting the only item", () => {
    const editor = makeEditor(p("before"), ul(li("on|e")));
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["|before"]);
  });
});

describe("cc", () => {
  it("clears the line but keeps the block, entering insert", () => {
    const editor = docFrom("ab|c", "z");
    const state = keys(editor, "cc");
    expect(snapshot(editor)).toEqual(["|", "z"]);
    expect(state.mode).toBe("insert");
  });

  it("merges a multi-line change into one empty line", () => {
    const editor = docFrom("a|a", "bb", "cc");
    keys(editor, "2cc");
    expect(snapshot(editor)).toEqual(["|", "cc"]);
  });
});

describe("yank and paste", () => {
  it("yy + p pastes the line below", () => {
    const editor = docFrom("ab|c", "z");
    const state = keys(editor, "yy");
    expect(state.register?.kind).toBe("line");
    keys(editor, "p", state);
    expect(snapshot(editor)).toEqual(["abc", "|abc", "z"]);
  });

  it("yy + P pastes the line above", () => {
    const editor = docFrom("ab|c", "z");
    const state = keys(editor, "yyP");
    expect(snapshot(editor)).toEqual(["|abc", "abc", "z"]);
    expect(state.mode).toBe("normal");
  });

  it("takes a paste count", () => {
    const editor = docFrom("a|", "z");
    keys(editor, "yy2p");
    expect(snapshot(editor)).toEqual(["a", "|a", "a", "z"]);
  });

  it("dd + p moves a line", () => {
    const editor = docFrom("on|e", "two");
    keys(editor, "ddp");
    expect(snapshot(editor)).toEqual(["two", "|one"]);
  });

  it("yanks and pastes list items as sibling items", () => {
    const editor = makeEditor(ul(li("on|e"), li("two")));
    keys(editor, "yyp");
    expect(snapshot(editor)).toEqual(["li:one", "li:|one", "li:two"]);
  });

  it("unwraps a yanked list item when pasting into paragraphs", () => {
    const editor = makeEditor(ul(li("it|em")), p("after"));
    const state = keys(editor, "yy");
    keys(editor, "jp", state);
    expect(snapshot(editor)).toEqual(["li:item", "after", "|item"]);
  });

  it("pastes linewise into a code block as text lines", () => {
    const editor = makeEditor(p("hell|o"), code("aa\nbb"));
    const state = keys(editor, "yy");
    keys(editor, "jp", state);
    expect(snapshot(editor)).toEqual(["hello", "code:aa\n|hello\nbb"]);
  });

  it("yanks a code-block virtual line and pastes it in the block", () => {
    const editor = makeEditor(code("a|a\nbb"));
    keys(editor, "yyp");
    expect(snapshot(editor)).toEqual(["code:aa\n|aa\nbb"]);
  });

  it("yw + p pastes charwise after the cursor", () => {
    const editor = docFrom("o|ne two");
    keys(editor, "ywp");
    // yw yanks "ne "; p inserts it after the cursor char, caret on the
    // last pasted char (the space).
    expect(snapshot(editor)).toEqual(["onne| e two"]);
  });

  it("supports the xp character swap idiom", () => {
    const editor = docFrom("ab|cd");
    keys(editor, "xp");
    expect(snapshot(editor)).toEqual(["abd|c"]);
  });

  it("P pastes charwise before the cursor", () => {
    const editor = docFrom("a|bc");
    keys(editor, "ylP");
    // yl yanks "b", P before cursor pastes it: "a" + "b" + "bc"
    expect(snapshot(editor)).toEqual(["a|bbc"]);
  });

  it("y leaves the cursor at the start of the yanked range", () => {
    const editor = docFrom("one |two");
    const state = keys(editor, "yw");
    expect(snapshot(editor)).toEqual(["one |two"]);
    expect(state.register?.kind).toBe("char");
  });
});

describe("undo and redo", () => {
  it("undoes a dd and redoes it", () => {
    const editor = docFrom("on|e", "two");
    const state = keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["|two"]);
    keys(editor, "u", state);
    expect(snapshot(editor).map((s) => s.replace(/[|⟨⟩]/g, ""))).toEqual([
      "one",
      "two",
    ]);
    keys(editor, "<C-r>", state);
    expect(snapshot(editor).map((s) => s.replace(/[|⟨⟩]/g, ""))).toEqual([
      "two",
    ]);
  });
});

describe("linewise units on items owning nested lists", () => {
  const nestedDoc = () =>
    makeEditor(ul(li("par|ent", ul(li("child"))), li("sibling")));

  it("dd removes the item including its nested list", () => {
    const editor = nestedDoc();
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["li:|sibling"]);
  });

  it("dd on the nested child leaves the parent intact", () => {
    const editor = makeEditor(
      ul(li("parent", ul(li("chi|ld"))), li("sibling")),
    );
    keys(editor, "dd");
    expect(snapshot(editor)).toEqual(["li:parent", "li:|sibling"]);
  });

  it("yyp duplicates the item including its nested list", () => {
    const editor = nestedDoc();
    keys(editor, "yyp");
    expect(snapshot(editor)).toEqual([
      "li:parent",
      "li2:child",
      "li:|parent",
      "li2:child",
      "li:sibling",
    ]);
  });

  it("yyP pastes the item and its nested list above", () => {
    const editor = nestedDoc();
    keys(editor, "yyP");
    expect(snapshot(editor)).toEqual([
      "li:|parent",
      "li2:child",
      "li:parent",
      "li2:child",
      "li:sibling",
    ]);
  });

  it("2dd spanning parent and child captures the item once", () => {
    const editor = nestedDoc();
    keys(editor, "2ddp");
    expect(snapshot(editor)).toEqual([
      "li:sibling",
      "li:|parent",
      "li2:child",
    ]);
  });

  it("cc clears the parent line but keeps the nested list", () => {
    const editor = nestedDoc();
    const state = keys(editor, "cc");
    expect(snapshot(editor)).toEqual(["li:|", "li2:child", "li:sibling"]);
    expect(state.mode).toBe("insert");
  });

  it("unwraps an item with a nested list when pasting into paragraphs", () => {
    const editor = makeEditor(
      ul(li("par|ent", ul(li("child")))),
      p("after"),
    );
    const state = keys(editor, "yy");
    keys(editor, "Gp", state);
    expect(snapshot(editor)).toEqual([
      "li:parent",
      "li2:child",
      "after",
      "|parent",
      "li:child",
    ]);
  });
});

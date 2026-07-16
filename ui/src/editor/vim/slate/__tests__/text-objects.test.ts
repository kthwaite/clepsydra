import { describe, expect, it } from "vitest";
import { docFrom, snapshot } from "./fixtures";
import { keys } from "./helpers";

describe("word objects", () => {
  it("diw deletes the word under the cursor", () => {
    const editor = docFrom("one tw|o three");
    keys(editor, "diw");
    expect(snapshot(editor)).toEqual(["one | three"]);
  });

  it("diw on whitespace deletes the whitespace run", () => {
    const editor = docFrom("one |   two");
    keys(editor, "diw");
    expect(snapshot(editor)).toEqual(["one|two"]);
  });

  it("daw deletes the word plus trailing whitespace", () => {
    const editor = docFrom("one tw|o three");
    keys(editor, "daw");
    expect(snapshot(editor)).toEqual(["one |three"]);
  });

  it("daw takes leading whitespace when nothing trails", () => {
    const editor = docFrom("one thre|e");
    keys(editor, "daw");
    expect(snapshot(editor)).toEqual(["on|e"]);
  });

  it("ciw enters insert mode", () => {
    const editor = docFrom("one tw|o three");
    const state = keys(editor, "ciw");
    expect(snapshot(editor)).toEqual(["one | three"]);
    expect(state.mode).toBe("insert");
  });

  it("diw treats punctuation as its own word", () => {
    const editor = docFrom("foo.|bar");
    keys(editor, "diw");
    expect(snapshot(editor)).toEqual(["foo|."]);
  });
});

describe("quote objects", () => {
  it('di" empties the quotes around the cursor', () => {
    const editor = docFrom('say "hel|lo" now');
    keys(editor, 'di"');
    expect(snapshot(editor)).toEqual(['say "|" now']);
  });

  it('da" removes the quotes too', () => {
    const editor = docFrom('say "hel|lo" now');
    keys(editor, 'da"');
    expect(snapshot(editor)).toEqual(["say | now"]);
  });

  it('di" from before the pair targets the next pair', () => {
    const editor = docFrom('s|ay "hello" now');
    keys(editor, 'di"');
    expect(snapshot(editor)).toEqual(['say "|" now']);
  });

  it("di' works with single quotes", () => {
    const editor = docFrom("it 'wo|rks' fine");
    keys(editor, "di'");
    expect(snapshot(editor)).toEqual(["it '|' fine"]);
  });

  it('di" no-ops without a pair', () => {
    const editor = docFrom('say "hel|lo now');
    keys(editor, 'di"');
    expect(snapshot(editor)).toEqual(['say "hel|lo now']);
  });
});

describe("bracket objects", () => {
  it("di( empties the parens", () => {
    const editor = docFrom("f(a, |b) end");
    keys(editor, "di(");
    expect(snapshot(editor)).toEqual(["f(|) end"]);
  });

  it("da( removes the parens too", () => {
    const editor = docFrom("f(a, |b) end");
    keys(editor, "da(");
    expect(snapshot(editor)).toEqual(["f| end"]);
  });

  it("dib is an alias for di(", () => {
    const editor = docFrom("f(a, |b) end");
    keys(editor, "dib");
    expect(snapshot(editor)).toEqual(["f(|) end"]);
  });

  it("understands nesting", () => {
    const editor = docFrom("a(b(c)d|e)f");
    keys(editor, "di(");
    expect(snapshot(editor)).toEqual(["a(|)f"]);
  });

  it("matches the pair a closer under the cursor closes", () => {
    const editor = docFrom("a(b(c|)d)e");
    keys(editor, "di(");
    expect(snapshot(editor)).toEqual(["a(b(|)d)e"]);
  });

  it("works when the cursor is on the opener", () => {
    const editor = docFrom("a|(bc)d");
    keys(editor, "di(");
    expect(snapshot(editor)).toEqual(["a(|)d"]);
  });

  it("spans multiple lines with di{", () => {
    const editor = docFrom("if x {", "  bo|dy", "}");
    keys(editor, "di{");
    // Cross-block charwise delete merges the lines around the braces.
    expect(snapshot(editor)).toEqual(["if x {|}"]);
  });

  it("no-ops when unbalanced", () => {
    const editor = docFrom("a(b|c");
    keys(editor, "di(");
    expect(snapshot(editor)).toEqual(["a(b|c"]);
  });
});

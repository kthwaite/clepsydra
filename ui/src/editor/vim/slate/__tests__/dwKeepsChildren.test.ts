/**
 * `dw` or `cw` on an empty line removes just its line break. On the lead line of
 * an item that holds more, there is no break to give: the line stands for the
 * item, so removing it would take everything inside it. Nothing is removed.
 */
import { describe, expect, it } from "vitest";
import { code, docFrom, li, makeEditor, p, snapshot, ul } from "./fixtures";
import { keys } from "./helpers";

describe("dw on an empty parent", () => {
  const nested = () => makeEditor(ul(li("|", ul(li("kid"))), li("sib")));

  it("leaves the parent and its children as they are", () => {
    const editor = nested();
    const state = keys(editor, "dw");
    expect(snapshot(editor)).toEqual(["li:|", "li2:kid", "li:sib"]);
    expect(state.mode).toBe("normal");
  });

  it("does not overwrite the register", () => {
    const editor = makeEditor(ul(li("ke|ep"), li("", ul(li("kid")))));
    let state = keys(editor, "yiw");
    const held = state.register;
    state = keys(editor, "j", state);
    state = keys(editor, "dw", state);
    expect(snapshot(editor)).toEqual(["li:keep", "li:|", "li2:kid"]);
    expect(state.register).toBe(held);
  });

  it("also keeps a code block or paragraph inside the item", () => {
    const withCode = makeEditor(ul(li("|", code("x")), li("sib")));
    keys(withCode, "dw");
    expect(snapshot(withCode)).toEqual(["li:|", "code:x", "li:sib"]);
    const withPara = makeEditor(ul(li("|", p("x")), li("sib")));
    keys(withPara, "dw");
    expect(snapshot(withPara)).toEqual(["li:|", "li:x", "li:sib"]);
  });
});

describe("cw on an empty parent", () => {
  it("enters insert on that line and keeps the children", () => {
    const editor = makeEditor(ul(li("|", ul(li("kid"))), li("sib")));
    const state = keys(editor, "cw");
    expect(snapshot(editor)).toEqual(["li:|", "li2:kid", "li:sib"]);
    expect(state.mode).toBe("insert");
  });
});

describe("dw on an empty line with nothing inside it", () => {
  it("still removes an empty childless item", () => {
    const editor = makeEditor(ul(li("|"), li("sib")));
    keys(editor, "dw");
    expect(snapshot(editor)).toEqual(["li:|sib"]);
  });

  it("still removes an empty paragraph", () => {
    const editor = docFrom("|", "two");
    keys(editor, "dw");
    expect(snapshot(editor)).toEqual(["|two"]);
  });

  it("still removes an empty nested item", () => {
    const editor = makeEditor(ul(li("a", ul(li("|"))), li("sib")));
    keys(editor, "dw");
    expect(snapshot(editor)).toEqual(["li:a", "li:|sib"]);
  });
});

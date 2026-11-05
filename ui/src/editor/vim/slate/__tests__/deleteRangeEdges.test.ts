/**
 * Slate reads a collapsed `at` as "delete one char forward", and by default
 * shrinks a range that ends at the start of a block. Neither is what a vim
 * command that names its own range means.
 */
import { describe, expect, it } from "vitest";
import { docFrom, li, makeEditor, snapshot, ul } from "./fixtures";
import { keys } from "./helpers";

describe("cc on an empty line", () => {
  it("leaves the next item where it is", () => {
    const editor = makeEditor(ul(li("|"), li("cd")));
    keys(editor, "cc");
    expect(snapshot(editor)).toEqual(["li:|", "li:cd"]);
  });

  it("does not promote a child over its empty parent", () => {
    const editor = makeEditor(ul(li("|", ul(li("kid")))));
    keys(editor, "cc");
    expect(snapshot(editor)).toEqual(["li:|", "li2:kid"]);
  });

  it("leaves the next paragraph where it is", () => {
    const editor = docFrom("|", "cd");
    keys(editor, "cc");
    expect(snapshot(editor)).toEqual(["|", "cd"]);
  });
});

describe("J on an empty line", () => {
  it("joins the next item up", () => {
    const editor = makeEditor(ul(li("|"), li("cd")));
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["li:|cd"]);
  });

  it("joins the next paragraph up", () => {
    const editor = docFrom("|", "cd");
    keys(editor, "J");
    expect(snapshot(editor)).toEqual(["|cd"]);
  });
});

describe("a span ending on an empty line", () => {
  it("2cc removes the empty second line", () => {
    const editor = makeEditor(ul(li("|ab"), li(""), li("cd")));
    keys(editor, "2cc");
    expect(snapshot(editor)).toEqual(["li:|", "li:cd"]);
  });

  it("Vjc removes the empty second line", () => {
    const editor = docFrom("|ab", "", "cd");
    keys(editor, "Vjc");
    expect(snapshot(editor)).toEqual(["|", "cd"]);
  });

  it("v from column 0 removes the line break it spans", () => {
    const editor = docFrom("|ab", "", "z");
    keys(editor, "vjd");
    expect(snapshot(editor)).toEqual(["|", "z"]);
  });
});

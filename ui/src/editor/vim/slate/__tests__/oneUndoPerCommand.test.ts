/**
 * One `u` undoes one vim command. Slate history merges an edit into the previous
 * batch when it follows a selection change in the same tick, or when it deletes
 * text right next to the previous delete. A real keypress is its own task, so
 * these tests yield between commands.
 */
import type { Editor } from "slate";
import { describe, expect, it } from "vitest";
import type { VimState } from "../types";
import { INITIAL_VIM_STATE } from "../types";
import { code, docFrom, li, makeEditor, snapshot, ul } from "./fixtures";
import { keys } from "./helpers";

const plain = (editor: Editor) =>
  snapshot(editor).map((line) => line.replace(/[|⟨⟩]/g, ""));

/** Runs each command as its own keypress, threading vim state between them. */
async function run(editor: Editor, ...commands: string[]): Promise<VimState> {
  let state = INITIAL_VIM_STATE;
  for (const command of commands) {
    state = keys(editor, command, state);
    await Promise.resolve();
    await Promise.resolve();
  }
  return state;
}

describe("one u undoes one command", () => {
  it("xp then u undoes only the paste", async () => {
    const editor = makeEditor(ul(li("a|bcd")));
    await run(editor, "x", "p", "u");
    expect(plain(editor)).toEqual(["li:acd"]);
  });

  it("dd, yw, p then u keeps the dd", async () => {
    const editor = makeEditor(ul(li("|one"), li("two three")));
    await run(editor, "dd", "yw", "p", "u");
    expect(plain(editor)).toEqual(["li:two three"]);
  });

  it("two x at the end of a line are two steps", async () => {
    const editor = makeEditor(ul(li("abc|d")));
    await run(editor, "x", "x", "u");
    expect(plain(editor)).toEqual(["li:abc"]);
  });

  it("x h x are two steps", async () => {
    const editor = makeEditor(ul(li("ab|cd")));
    await run(editor, "x", "h", "x", "u");
    expect(plain(editor)).toEqual(["li:abd"]);
  });

  it("x then o in a paragraph are two steps", async () => {
    const editor = docFrom("a|bc", "z");
    await run(editor, "x", "o", "<Esc>", "u");
    expect(plain(editor)).toEqual(["ac", "z"]);
  });

  it("x then O in a paragraph are two steps", async () => {
    const editor = docFrom("a|bc", "z");
    await run(editor, "x", "O", "<Esc>", "u");
    expect(plain(editor)).toEqual(["ac", "z"]);
  });

  it("two dd in a code block are two steps", async () => {
    const editor = makeEditor(code("aa\nb|b\ncc"));
    await run(editor, "dd", "k", "dd", "u");
    expect(plain(editor)[0]).toBe("code:aa\ncc");
  });

  it("the second u undoes the earlier command", async () => {
    const editor = makeEditor(ul(li("a|bcd")));
    await run(editor, "x", "p", "u", "u");
    expect(plain(editor)).toEqual(["li:abcd"]);
  });

  it("redo steps forward one command at a time", async () => {
    const editor = makeEditor(ul(li("a|bcd")));
    await run(editor, "x", "p", "u", "u", "<C-r>");
    expect(plain(editor)).toEqual(["li:acd"]);
  });

  it("a command with many operations is one step", async () => {
    const editor = makeEditor(ul(li("|a"), li("b"), li("c"), li("d")));
    await run(editor, "3dd", "u");
    expect(plain(editor)).toEqual(["li:a", "li:b", "li:c", "li:d"]);
  });
});

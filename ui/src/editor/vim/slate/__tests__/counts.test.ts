/**
 * Oversized counts must never throw, hang, or allocate absurd structures:
 * motions clamp at document bounds, undo stops when history runs dry, and
 * content-producing pastes are capped separately.
 */
import { Node } from "slate";
import { describe, expect, it } from "vitest";
import { code, docFrom, makeEditor, snapshot } from "./fixtures";
import { keys } from "./helpers";

const HUGE = "9999999999";

describe("oversized counts", () => {
  it(`${HUGE}p inside a code block does not throw and is capped`, () => {
    const editor = makeEditor(code("a|b"));
    expect(() => keys(editor, `yy${HUGE}p`)).not.toThrow();
    const text = Node.string(editor.children[0]);
    expect(text.split("\n").length).toBe(1 + 1000);
  });

  it(`${HUGE}p on a paragraph caps the number of pasted lines`, () => {
    const editor = docFrom("a|b");
    keys(editor, `yy${HUGE}p`);
    expect(editor.children.length).toBe(1 + 1000);
  });

  it(`${HUGE}w clamps at the document end without iterating to the count`, () => {
    const editor = docFrom("|one two", "three four");
    keys(editor, `${HUGE}w`);
    // Vim's w clamps on the buffer's last character.
    expect(snapshot(editor)).toEqual(["one two", "three fou|r"]);
  });

  it(`${HUGE}u stops when the undo history is exhausted`, () => {
    const editor = docFrom("ab|c");
    keys(editor, "x");
    keys(editor, `${HUGE}u`);
    expect(snapshot(editor)).toEqual(["ab|c"]);
  });

  it(`c${HUGE}w clamps its word-end walk at the document end`, () => {
    const editor = docFrom("|one two three");
    keys(editor, `c${HUGE}w`);
    expect(snapshot(editor)).toEqual(["|"]);
  });
}, 10_000);

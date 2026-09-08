import { createEditor, type Descendant, type Path, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withAutoformat } from "#/editor/plugins/autoformat/withAutoformat";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { makeCodeBlock } from "#/editor/schema/elements/codeBlock";
import { makeJournalTime } from "#/editor/schema/elements/journalTime";
import { makeMathBlock } from "#/editor/schema/elements/math";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import {
  makeTable,
  makeTableCell,
  makeTableRow,
} from "#/editor/schema/elements/table";
import { makeThematicBreak } from "#/editor/schema/elements/thematicBreak";
import { withSchema } from "#/editor/schema/withSchema";
import { escapeTrappingBlock, isTrappingBlock } from "../blockEscape";

// Import types so module augmentation is active
import "#/editor/types";

/**
 * Builds the real plugin chain minus withReact. The document is NOT
 * normalised: the trailing-paragraph document rule would otherwise append a
 * paragraph after a terminal code block / table / time heading and hide the
 * "below" escape this module exists to provide.
 */
function makeEditor(children: Descendant[], path: Path, offset = 0) {
  const editor = withHistory(
    withAutoformat(withOutliner(withSchema(createEditor()))),
  );
  editor.children = children;
  Transforms.select(editor, { path, offset });
  return editor;
}

const EMPTY = makeParagraph({});
const HELLO = makeParagraph({ children: [{ text: "hello" }] });
const twoLineCode = () =>
  makeCodeBlock({ children: [{ text: "first\nsecond" }] });
const table = () =>
  makeTable({
    align: ["left"],
    children: [
      makeTableRow({
        children: [makeTableCell({ header: true, children: [{ text: "A" }] })],
      }),
      makeTableRow({
        children: [makeTableCell({ children: [{ text: "1" }] })],
      }),
    ],
  });

describe("isTrappingBlock", () => {
  it("traps void blocks, code blocks and tables", () => {
    expect(isTrappingBlock(makeThematicBreak({}))).toBe(true);
    expect(isTrappingBlock(makeJournalTime({ time: "09:05" }))).toBe(true);
    expect(isTrappingBlock(makeMathBlock({ tex: "x", delimiter: "$$" }))).toBe(
      true,
    );
    expect(isTrappingBlock(twoLineCode())).toBe(true);
    expect(isTrappingBlock(table())).toBe(true);
  });

  it("does not trap ordinary blocks or text", () => {
    expect(isTrappingBlock(HELLO)).toBe(false);
    expect(isTrappingBlock({ text: "plain" })).toBe(false);
  });
});

describe("escapeTrappingBlock", () => {
  describe("code block", () => {
    it("escapes above from the first line of a leading code block", () => {
      const editor = makeEditor([twoLineCode(), HELLO], [0, 0], 3);

      expect(escapeTrappingBlock(editor, "above")).toBe(true);

      expect(editor.children).toEqual([EMPTY, twoLineCode(), HELLO]);
      expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
      expect(editor.selection?.focus).toEqual({ path: [0, 0], offset: 0 });
    });

    it("does nothing above from the second line", () => {
      const editor = makeEditor([twoLineCode(), HELLO], [0, 0], 8);

      expect(escapeTrappingBlock(editor, "above")).toBe(false);

      expect(editor.children).toEqual([twoLineCode(), HELLO]);
      expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 8 });
    });

    it("escapes below from the last line of a terminal code block", () => {
      const editor = makeEditor([HELLO, twoLineCode()], [1, 0], 9);

      expect(escapeTrappingBlock(editor, "below")).toBe(true);

      expect(editor.children).toEqual([HELLO, twoLineCode(), EMPTY]);
      expect(editor.selection?.anchor).toEqual({ path: [2, 0], offset: 0 });
    });

    it("does nothing below from the first line", () => {
      const editor = makeEditor([HELLO, twoLineCode()], [1, 0], 2);

      expect(escapeTrappingBlock(editor, "below")).toBe(false);

      expect(editor.children).toEqual([HELLO, twoLineCode()]);
    });

    it("does nothing when the code block is not the first block", () => {
      const editor = makeEditor([HELLO, twoLineCode()], [1, 0], 0);

      expect(escapeTrappingBlock(editor, "above")).toBe(false);

      expect(editor.children).toEqual([HELLO, twoLineCode()]);
    });

    it("does nothing with an expanded selection", () => {
      const editor = makeEditor([twoLineCode(), HELLO], [0, 0], 0);
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 3 },
      });

      expect(escapeTrappingBlock(editor, "above")).toBe(false);

      expect(editor.children).toEqual([twoLineCode(), HELLO]);
    });
  });

  describe("table", () => {
    it("escapes above from the first row of a leading table", () => {
      const editor = makeEditor([table(), HELLO], [0, 0, 0, 0], 1);

      expect(escapeTrappingBlock(editor, "above")).toBe(true);

      expect(editor.children).toEqual([EMPTY, table(), HELLO]);
      expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
    });

    it("does nothing above from the second row", () => {
      const editor = makeEditor([table(), HELLO], [0, 1, 0, 0], 0);

      expect(escapeTrappingBlock(editor, "above")).toBe(false);

      expect(editor.children).toEqual([table(), HELLO]);
    });

    it("escapes below from the last row of a terminal table", () => {
      const editor = makeEditor([HELLO, table()], [1, 1, 0, 0], 0);

      expect(escapeTrappingBlock(editor, "below")).toBe(true);

      expect(editor.children).toEqual([HELLO, table(), EMPTY]);
      expect(editor.selection?.anchor).toEqual({ path: [2, 0], offset: 0 });
    });

    it("does nothing below from the first row", () => {
      const editor = makeEditor([HELLO, table()], [1, 0, 0, 0], 1);

      expect(escapeTrappingBlock(editor, "below")).toBe(false);

      expect(editor.children).toEqual([HELLO, table()]);
    });
  });

  describe("void blocks", () => {
    it("escapes above a leading thematic break", () => {
      const editor = makeEditor([makeThematicBreak({}), HELLO], [0, 0]);

      expect(escapeTrappingBlock(editor, "above")).toBe(true);

      expect(editor.children).toEqual([EMPTY, makeThematicBreak({}), HELLO]);
      expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
    });

    it("escapes below a terminal thematic break", () => {
      const editor = makeEditor([HELLO, makeThematicBreak({})], [1, 0]);

      expect(escapeTrappingBlock(editor, "below")).toBe(true);

      expect(editor.children).toEqual([HELLO, makeThematicBreak({}), EMPTY]);
      expect(editor.selection?.anchor).toEqual({ path: [2, 0], offset: 0 });
    });

    it("escapes above a leading time heading", () => {
      const time = makeJournalTime({ time: "09:05" });
      const editor = makeEditor([time, HELLO], [0, 0]);

      expect(escapeTrappingBlock(editor, "above")).toBe(true);

      expect(editor.children).toEqual([EMPTY, time, HELLO]);
      expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
    });

    it("escapes below a terminal math block", () => {
      const math = makeMathBlock({ tex: "x", delimiter: "$$" });
      const editor = makeEditor([HELLO, math], [1, 0]);

      expect(escapeTrappingBlock(editor, "below")).toBe(true);

      expect(editor.children).toEqual([HELLO, math, EMPTY]);
    });
  });

  describe("non-trapping blocks", () => {
    it("does nothing from a leading paragraph", () => {
      const editor = makeEditor([HELLO, twoLineCode()], [0, 0]);

      expect(escapeTrappingBlock(editor, "above")).toBe(false);
      expect(escapeTrappingBlock(editor, "below")).toBe(false);

      expect(editor.children).toEqual([HELLO, twoLineCode()]);
    });

    it("does nothing without a selection", () => {
      const editor = makeEditor([twoLineCode()], [0, 0]);
      Transforms.deselect(editor);

      expect(escapeTrappingBlock(editor, "above")).toBe(false);
    });
  });
});

import { createEditor, type Descendant, type Path, Transforms } from "slate";
import { withHistory } from "slate-history";
import { describe, expect, it } from "vitest";
import { withAutoformat } from "#/editor/plugins/autoformat/withAutoformat";
import { withOutliner } from "#/editor/plugins/withOutliner";
import { makeCodeBlock } from "#/editor/schema/elements/codeBlock";
import { makeJournalTime } from "#/editor/schema/elements/journalTime";
import { makeParagraph } from "#/editor/schema/elements/paragraph";
import {
  makeTable,
  makeTableCell,
  makeTableRow,
} from "#/editor/schema/elements/table";
import { makeThematicBreak } from "#/editor/schema/elements/thematicBreak";
import { withSchema } from "#/editor/schema/withSchema";
import { selectAdjacentVoidBlock } from "../voidNavigation";

// Import types so module augmentation is active
import "#/editor/types";

/** Real plugin chain minus withReact; the document is NOT normalised. */
function makeEditor(children: Descendant[], path: Path, offset = 0) {
  const editor = withHistory(
    withAutoformat(withOutliner(withSchema(createEditor()))),
  );
  editor.children = children;
  Transforms.select(editor, { path, offset });
  return editor;
}

const HELLO = makeParagraph({ children: [{ text: "hello" }] });
const time = () => makeJournalTime({ time: "09:05" });
const rule = () => makeThematicBreak({});
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

describe("selectAdjacentVoidBlock", () => {
  describe("code block", () => {
    it("selects the time heading above from the first line", () => {
      const editor = makeEditor([time(), twoLineCode()], [1, 0], 3);

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(true);

      expect(editor.children).toEqual([time(), twoLineCode()]);
      expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
      expect(editor.selection?.focus).toEqual({ path: [0, 0], offset: 0 });
    });

    it("does nothing above from the second line", () => {
      const editor = makeEditor([time(), twoLineCode()], [1, 0], 8);

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(false);

      expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 8 });
    });

    it("selects the thematic break below from the last line", () => {
      const editor = makeEditor([twoLineCode(), rule(), HELLO], [0, 0], 9);

      expect(selectAdjacentVoidBlock(editor, "below")).toBe(true);

      expect(editor.children).toEqual([twoLineCode(), rule(), HELLO]);
      expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });
    });

    it("does nothing below from a line that is not the last", () => {
      const editor = makeEditor([twoLineCode(), rule()], [0, 0], 2);

      expect(selectAdjacentVoidBlock(editor, "below")).toBe(false);

      expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 2 });
    });

    it("does nothing when the neighbour is a paragraph", () => {
      const editor = makeEditor([HELLO, twoLineCode(), HELLO], [1, 0], 0);

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(false);
      Transforms.select(editor, { path: [1, 0], offset: 12 });
      expect(selectAdjacentVoidBlock(editor, "below")).toBe(false);
    });

    it("does nothing when there is no neighbour", () => {
      const editor = makeEditor([twoLineCode()], [0, 0], 0);

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(false);
      Transforms.select(editor, { path: [0, 0], offset: 12 });
      expect(selectAdjacentVoidBlock(editor, "below")).toBe(false);
    });

    it("does nothing with an expanded selection", () => {
      const editor = makeEditor([time(), twoLineCode()], [1, 0], 0);
      Transforms.select(editor, {
        anchor: { path: [1, 0], offset: 0 },
        focus: { path: [1, 0], offset: 3 },
      });

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(false);
    });
  });

  describe("table", () => {
    it("selects the time heading above from the first row", () => {
      const editor = makeEditor([time(), table()], [1, 0, 0, 0], 1);

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(true);

      expect(editor.selection?.anchor).toEqual({ path: [0, 0], offset: 0 });
    });

    it("does nothing above from the second row", () => {
      const editor = makeEditor([time(), table()], [1, 1, 0, 0], 0);

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(false);
    });

    it("selects the thematic break below from the last row", () => {
      const editor = makeEditor([table(), rule()], [0, 1, 0, 0], 1);

      expect(selectAdjacentVoidBlock(editor, "below")).toBe(true);

      expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });
    });

    it("does nothing below from the first row", () => {
      const editor = makeEditor([table(), rule()], [0, 0, 0, 0], 1);

      expect(selectAdjacentVoidBlock(editor, "below")).toBe(false);
    });
  });

  describe("other blocks", () => {
    it("leaves a paragraph next to a void block to native caret movement", () => {
      const editor = makeEditor([time(), HELLO, rule()], [1, 0], 0);

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(false);
      expect(selectAdjacentVoidBlock(editor, "below")).toBe(false);

      expect(editor.selection?.anchor).toEqual({ path: [1, 0], offset: 0 });
    });

    it("does nothing without a selection", () => {
      const editor = makeEditor([time(), twoLineCode()], [1, 0]);
      Transforms.deselect(editor);

      expect(selectAdjacentVoidBlock(editor, "above")).toBe(false);
    });
  });
});

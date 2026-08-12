import { createEditor, type Descendant, type Editor } from "slate";
import { describe, expect, it, vi } from "vitest";
import { withSchema } from "#/editor/schema/withSchema";
import { withMathClipboard } from "../withMathClipboard";

const INTERNAL_FRAGMENT = "application/x-slate-fragment";

class MemoryDataTransfer {
  private readonly values = new Map<string, string>();

  getData(type: string): string {
    return this.values.get(type) ?? "";
  }

  setData(type: string, value: string): void {
    this.values.set(type, value);
  }
}

function value(): Descendant[] {
  return [
    {
      type: "paragraph",
      children: [
        { text: "before " },
        {
          type: "inline-math",
          tex: "x^2",
          delimiter: "\\(",
          children: [{ text: "" }],
        },
        { text: " after" },
      ],
    },
    {
      type: "math-block",
      tex: "y",
      delimiter: "$$",
      children: [{ text: "" }],
    },
    { type: "paragraph", children: [{ text: "plain" }] },
  ];
}

function makeEditor() {
  const editor = withSchema(createEditor());
  editor.children = value();
  const base = vi.fn((data: DataTransfer) => {
    const fragment = editor.getFragment();
    data.setData(INTERNAL_FRAGMENT, btoa(JSON.stringify(fragment)));
    data.setData("text/html", "<p>base html</p>");
    data.setData("text/plain", "base plain text");
  });
  editor.setFragmentData = base;
  withMathClipboard(editor);
  return { editor, base };
}

function dataTransfer(): DataTransfer {
  return new MemoryDataTransfer() as unknown as DataTransfer;
}

function selectInlineMath(editor: Editor): void {
  editor.selection = {
    anchor: { path: [0, 1, 0], offset: 0 },
    focus: { path: [0, 1, 0], offset: 0 },
  };
}

describe("withMathClipboard", () => {
  it("copies exact inline math as authored source and retains the Slate fragment", () => {
    const { editor, base } = makeEditor();
    selectInlineMath(editor);
    const data = dataTransfer();

    editor.setFragmentData(data, "copy");

    expect(data.getData("text/plain")).toBe(String.raw`\(x^2\)`);
    expect(data.getData(INTERNAL_FRAGMENT)).not.toBe("");
    expect(data.getData("text/html")).toBe("<p>base html</p>");
    expect(base).toHaveBeenCalledWith(data, "copy");
  });

  it("copies an exact display selection as authored display source", () => {
    const { editor } = makeEditor();
    editor.selection = {
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 0 },
    };
    const data = dataTransfer();

    editor.setFragmentData(data, "copy");

    expect(data.getData("text/plain")).toBe("$$\ny\n$$");
    expect(data.getData(INTERNAL_FRAGMENT)).not.toBe("");
  });

  it("copies mixed text and math as Markdown with authored math source", () => {
    const { editor } = makeEditor();
    editor.selection = {
      anchor: { path: [0, 0], offset: 0 },
      focus: { path: [0, 2], offset: " after".length },
    };
    const data = dataTransfer();

    editor.setFragmentData(data, "copy");

    expect(data.getData("text/plain")).toBe(String.raw`before \(x^2\) after`);
    expect(data.getData(INTERNAL_FRAGMENT)).not.toBe("");
  });

  it("delegates unchanged when the selected fragment contains no math", () => {
    const { editor, base } = makeEditor();
    editor.selection = {
      anchor: { path: [2, 0], offset: 0 },
      focus: { path: [2, 0], offset: "plain".length },
    };
    const data = dataTransfer();

    editor.setFragmentData(data, "copy");

    expect(data.getData("text/plain")).toBe("base plain text");
    expect(data.getData(INTERNAL_FRAGMENT)).not.toBe("");
    expect(base).toHaveBeenCalledTimes(1);
  });

  it("uses source-correct plain text for cut without changing base cut behavior", () => {
    const { editor, base } = makeEditor();
    selectInlineMath(editor);
    const before = structuredClone(editor.children);
    const data = dataTransfer();

    editor.setFragmentData(data, "cut");

    expect(data.getData("text/plain")).toBe(String.raw`\(x^2\)`);
    expect(data.getData(INTERNAL_FRAGMENT)).not.toBe("");
    expect(base).toHaveBeenCalledWith(data, "cut");
    expect(editor.children).toEqual(before);
  });
});

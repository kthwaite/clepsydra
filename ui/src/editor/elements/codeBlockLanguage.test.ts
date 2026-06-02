import { createEditor } from "slate";
import { describe, expect, it } from "vitest";
import { setCodeBlockLanguage } from "#/editor/elements/codeBlockLanguage";

function editorWithCodeBlock(language?: string) {
  const editor = createEditor();
  editor.children = [
    {
      type: "code-block",
      ...(language ? { language } : {}),
      children: [{ text: "const x = 1;" }],
    },
  ] as any;
  return editor;
}

describe("setCodeBlockLanguage", () => {
  it("sets the language on the targeted code block", () => {
    const editor = editorWithCodeBlock();
    setCodeBlockLanguage(editor, [0], "rust");
    expect((editor.children[0] as any).language).toBe("rust");
  });

  it("clears the language when given null", () => {
    const editor = editorWithCodeBlock("rust");
    setCodeBlockLanguage(editor, [0], null);
    expect((editor.children[0] as any).language).toBeUndefined();
  });
});

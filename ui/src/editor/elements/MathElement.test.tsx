import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { KeyboardEventHandler } from "react";
import {
  createEditor,
  type Descendant,
  Editor,
  Element as SlateElement,
  Node,
  Transforms,
} from "slate";
import { withHistory } from "slate-history";
import {
  Editable,
  type RenderElementProps,
  Slate,
  withReact,
} from "slate-react";
import { describe, expect, it, vi } from "vitest";
import { MathElement } from "#/editor/elements/MathElement";
import {
  MathEditingProvider,
  useMathEditingController,
} from "#/editor/mathEditing";
import { makeInlineMath } from "#/editor/schema/elements/math";
import { withSchema } from "#/editor/schema/withSchema";
import type {
  InlineMathElement,
  MathBlockElement,
} from "#/editor/types";

function MathEditingSurface({
  editor,
  onKeyDown,
}: {
  editor: Editor;
  onKeyDown?: KeyboardEventHandler;
}) {
  const controller = useMathEditingController(editor);
  const renderElement = (props: RenderElementProps) => {
    if (
      props.element.type === "inline-math" ||
      props.element.type === "math-block"
    ) {
      return (
        <MathElement
          {...props}
          element={props.element as InlineMathElement | MathBlockElement}
        />
      );
    }
    return <p {...props.attributes}>{props.children}</p>;
  };

  return (
    <MathEditingProvider value={controller}>
      <div onKeyDown={onKeyDown}>
        <Editable renderElement={renderElement} />
      </div>
    </MathEditingProvider>
  );
}

function renderMathEditor(
  kind: "inline" | "display" = "inline",
  onKeyDown?: KeyboardEventHandler,
) {
  const editor = withReact(withHistory(withSchema(createEditor())));
  const value: Descendant[] =
    kind === "inline"
      ? [
          {
            type: "paragraph",
            children: [
              { text: "before" },
              {
                type: "inline-math",
                tex: "x^2",
                delimiter: "$",
                children: [{ text: "" }],
              },
              { text: "after" },
            ],
          } as Descendant,
        ]
      : [
          {
            type: "math-block",
            tex: "x^2",
            delimiter: "$$",
            children: [{ text: "" }],
          } as Descendant,
        ];

  render(
    <Slate editor={editor} initialValue={value}>
      <MathEditingSurface editor={editor} onKeyDown={onKeyDown} />
    </Slate>,
  );
  return editor;
}

describe("MathElement", () => {
  it("opens inline source on click and commits it on blur", async () => {
    const user = userEvent.setup();
    const editor = renderMathEditor();

    await user.click(screen.getByTestId("inline-math"));
    const source = screen.getByRole("textbox", { name: "Edit inline math" });
    expect(source).toHaveValue("x^2");
    await user.clear(source);
    await user.type(source, "x^3");
    fireEvent.blur(source);

    expect(Node.get(editor, [0, 1])).toMatchObject({
      tex: "x^3",
      delimiter: "$",
    });
    expect(
      screen.queryByRole("textbox", { name: "Edit inline math" }),
    ).toBeNull();
  });

  it("commits valid source and closes on Escape", async () => {
    const user = userEvent.setup();
    const editor = renderMathEditor();

    await user.click(screen.getByTestId("inline-math"));
    const source = screen.getByRole("textbox", { name: "Edit inline math" });
    await user.clear(source);
    await user.type(source, "y");
    await user.keyboard("{Escape}");

    expect(Node.get(editor, [0, 1])).toMatchObject({ tex: "y" });
    expect(
      screen.queryByRole("textbox", { name: "Edit inline math" }),
    ).toBeNull();
  });

  it("commits invalid TeX but keeps its described source editor visible", async () => {
    const user = userEvent.setup();
    const editor = renderMathEditor();

    await user.click(screen.getByTestId("inline-math"));
    const source = screen.getByRole("textbox", { name: "Edit inline math" });
    fireEvent.change(source, { target: { value: String.raw`\notACommand{` } });
    fireEvent.blur(source);

    expect(Node.get(editor, [0, 1])).toMatchObject({
      tex: String.raw`\notACommand{`,
    });
    expect(source).toHaveAttribute("aria-invalid", "true");
    expect(source).toHaveAccessibleDescription("Invalid TeX source");
    expect(
      screen.getByRole("textbox", { name: "Edit inline math" }),
    ).toBe(source);
  });

  it.each([
    ["ArrowLeft", 0, { path: [0, 0], offset: 6 }],
    ["ArrowRight", String.raw`\notACommand{`.length, { path: [0, 2], offset: 0 }],
  ] as const)(
    "commits invalid TeX at the %s boundary without closing source",
    async (key, caret, expectedPoint) => {
      const user = userEvent.setup();
      const editor = renderMathEditor();
      const invalidTex = String.raw`\notACommand{`;

      await user.click(screen.getByTestId("inline-math"));
      const source = screen.getByRole<HTMLInputElement>("textbox", {
        name: "Edit inline math",
      });
      fireEvent.change(source, { target: { value: invalidTex } });
      source.setSelectionRange(caret, caret);
      fireEvent.keyDown(source, { key });

      expect(Node.get(editor, [0, 1])).toMatchObject({ tex: invalidTex });
      expect(editor.selection?.anchor).toEqual(expectedPoint);
      expect(source).toHaveValue(invalidTex);
      expect(source).toHaveAttribute("aria-invalid", "true");
      expect(
        screen.getByRole("textbox", { name: "Edit inline math" }),
      ).toBe(source);
    },
  );

  it.each([
    ["ArrowLeft", 0, { path: [0, 0], offset: 6 }],
    ["ArrowRight", 3, { path: [0, 2], offset: 0 }],
  ] as const)(
    "%s at the source boundary commits and exits the void",
    async (key, caret, expectedPoint) => {
      const user = userEvent.setup();
      const editor = renderMathEditor();

      await user.click(screen.getByTestId("inline-math"));
      const source = screen.getByRole<HTMLInputElement>("textbox", {
        name: "Edit inline math",
      });
      source.setSelectionRange(caret, caret);
      fireEvent.keyDown(source, { key });

      expect(Node.get(editor, [0, 1])).toMatchObject({ tex: "x^2" });
      expect(editor.selection?.anchor).toEqual(expectedPoint);
      expect(
        screen.queryByRole("textbox", { name: "Edit inline math" }),
      ).toBeNull();
    },
  );

  it("uses a labeled textarea for display math", async () => {
    const user = userEvent.setup();
    renderMathEditor("display");

    await user.click(screen.getByTestId("math-block"));

    const source = screen.getByRole("textbox", { name: "Edit display math" });
    expect(source.tagName).toBe("TEXTAREA");
    await waitFor(() => expect(source).toHaveFocus());
  });

  it("keeps display textarea keys local while allowing Enter to insert a newline", async () => {
    const user = userEvent.setup();
    const onSlateKeyDown = vi.fn();
    const editor = renderMathEditor("display", onSlateKeyDown);

    await user.click(screen.getByTestId("math-block"));
    const source = screen.getByRole<HTMLTextAreaElement>("textbox", {
      name: "Edit display math",
    });
    source.setSelectionRange(source.value.length, source.value.length);
    await user.keyboard("{Enter}y");

    expect(source).toHaveValue("x^2\ny");
    expect(onSlateKeyDown).not.toHaveBeenCalled();
    expect(editor.children).toHaveLength(1);
  });

  it("leaves non-boundary arrow keys to the source input", async () => {
    const user = userEvent.setup();
    const editor = renderMathEditor();

    await user.click(screen.getByTestId("inline-math"));
    const source = screen.getByRole<HTMLInputElement>("textbox", {
      name: "Edit inline math",
    });
    source.setSelectionRange(1, 1);
    fireEvent.keyDown(source, { key: "ArrowLeft" });

    expect(screen.getByRole("textbox", { name: "Edit inline math" })).toBe(
      source,
    );
    expect(Node.get(editor, [0, 1])).toMatchObject({ tex: "x^2" });
  });
});

describe("useMathEditingController", () => {
  it("tracks the original math node when siblings shift before commit", () => {
    const editor = withHistory(withSchema(createEditor()));
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "before" },
          makeInlineMath({ tex: "original", delimiter: "$" }),
          { text: "after" },
        ],
      },
    ] as Descendant[];
    const { result } = renderHook(() => useMathEditingController(editor));

    act(() => result.current.begin([0, 1]));
    act(() =>
      Transforms.insertNodes(
        editor,
        makeInlineMath({ tex: "inserted", delimiter: "$" }),
        { at: [0, 1] },
      ),
    );
    act(() => result.current.commit("changed"));

    const texValues = Array.from(
      Editor.nodes(editor, {
        at: [],
        match: (node) =>
          SlateElement.isElement(node) && node.type === "inline-math",
      }),
    ).map(([node]) => {
      if (!SlateElement.isElement(node) || node.type !== "inline-math") {
        throw new Error("Expected inline math");
      }
      return node.tex;
    });
    expect(texValues).toEqual(["inserted", "changed"]);
  });

  it("releases owned path refs on replacement, close, and unmount", () => {
    const editor = withHistory(withSchema(createEditor()));
    editor.children = [
      {
        type: "paragraph",
        children: [
          { text: "before" },
          makeInlineMath({ tex: "x", delimiter: "$" }),
          { text: "after" },
        ],
      },
    ] as Descendant[];
    const { result, unmount } = renderHook(() =>
      useMathEditingController(editor),
    );

    act(() => result.current.begin([0, 1]));
    expect(Editor.pathRefs(editor).size).toBe(1);
    act(() => result.current.begin([0, 1]));
    expect(Editor.pathRefs(editor).size).toBe(1);
    act(() => result.current.close());
    expect(Editor.pathRefs(editor).size).toBe(0);
    act(() => result.current.begin([0, 1]));
    expect(Editor.pathRefs(editor).size).toBe(1);

    unmount();
    expect(Editor.pathRefs(editor).size).toBe(0);
  });
});

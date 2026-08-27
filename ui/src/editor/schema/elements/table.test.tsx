import { render, screen } from "@testing-library/react";
import { createEditor, type Descendant, Editor } from "slate";
import { withHistory } from "slate-history";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { markdownToSlate } from "#/editor/convert";
import { renderElement } from "#/editor/elements/renderElement";
import { renderLeaf } from "#/editor/elements/renderLeaf";
import { withSchema } from "#/editor/schema/withSchema";

const TABLE_MARKDOWN = [
  "| Vessel | Depth | Note |",
  "| :--- | ---: | :---: |",
  "| Clepsydra | 12 | **brass** |",
].join("\n");

function renderMarkdown(markdown: string) {
  const editor = withReact(withHistory(withSchema(createEditor())));
  const value = markdownToSlate(markdown) as Descendant[];
  render(
    <Slate editor={editor} initialValue={value}>
      <Editable
        renderElement={renderElement}
        renderLeaf={renderLeaf}
        readOnly
      />
    </Slate>,
  );
  return editor;
}

describe("table element rendering", () => {
  it("renders a GFM table as a real table with a header row", () => {
    renderMarkdown(TABLE_MARKDOWN);

    const table = screen.getByRole("table");
    expect(table).toBeTruthy();
    expect(
      screen.getByRole("columnheader", { name: "Vessel" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Clepsydra" })).toBeInTheDocument();
    // The body row's cells are data cells, not headers.
    expect(table.querySelectorAll("th")).toHaveLength(3);
    expect(table.querySelectorAll("td")).toHaveLength(3);
  });

  it("applies the delimiter row's alignment to every cell in the column", () => {
    renderMarkdown(TABLE_MARKDOWN);

    expect(
      screen.getByRole("columnheader", { name: "Depth" }).className,
    ).toContain("text-right");
    expect(screen.getByRole("cell", { name: "12" }).className).toContain(
      "text-right",
    );
    expect(screen.getByRole("cell", { name: "brass" }).className).toContain(
      "text-center",
    );
  });

  it("keeps inline marks inside cells", () => {
    renderMarkdown(TABLE_MARKDOWN);
    expect(screen.getByText("brass").closest("strong")).not.toBeNull();
  });

  it("appends a trailing paragraph so a terminal table can be escaped", () => {
    const editor = renderMarkdown(TABLE_MARKDOWN);
    Editor.normalize(editor, { force: true });
    const last = editor.children[editor.children.length - 1] as {
      type: string;
    };
    expect(last.type).toBe("paragraph");
  });
});

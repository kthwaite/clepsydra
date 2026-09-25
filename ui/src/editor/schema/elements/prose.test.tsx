import { render, screen } from "@testing-library/react";
import { createEditor, type Descendant } from "slate";
import { withHistory } from "slate-history";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { markdownToSlate } from "#/editor/convert";
import { renderElement } from "#/editor/elements/renderElement";
import { renderLeaf } from "#/editor/elements/renderLeaf";
import { withSchema } from "#/editor/schema/withSchema";

function renderMarkdown(markdown: string) {
  const editor = withReact(withHistory(withSchema(createEditor())));
  const value = markdownToSlate(markdown) as Descendant[];
  return render(
    <Slate editor={editor} initialValue={value}>
      <Editable
        renderElement={renderElement}
        renderLeaf={renderLeaf}
        readOnly
      />
    </Slate>,
  );
}

describe("Stone & Lamp prose", () => {
  it("sets h1 and h2 in the serif, never bold", () => {
    renderMarkdown("# Title\n\n## Section");
    const h1 = screen.getByRole("heading", { level: 1, name: "Title" });
    const h2 = screen.getByRole("heading", { level: 2, name: "Section" });
    expect(h1).toHaveClass("font-serif", "text-[40px]");
    expect(h2).toHaveClass("font-serif", "text-[30px]");
    for (const h of [h1, h2]) {
      expect(h.className).not.toMatch(/font-(bold|black|semibold)/);
    }
  });

  it("hangs a cobalt tick in the margin of every h2, outside the editable text", () => {
    renderMarkdown("## Section");
    const h2 = screen.getByRole("heading", { level: 2, name: "Section" });
    const tick = h2.querySelector("[data-tick]");
    expect(tick).toHaveClass("bg-accent", "-left-[22px]");
    expect(tick).toHaveAttribute("contenteditable", "false");
    expect(tick).toHaveAttribute("aria-hidden");
  });

  it("drops caps and tracking from the small headings", () => {
    const { container } = renderMarkdown("##### Five\n\n###### Six");
    for (const h of container.querySelectorAll("h5, h6")) {
      expect(h.className).not.toMatch(/uppercase|tracking-/);
    }
  });

  it("draws a blockquote as an italic serif pull quote with a cobalt open-quote", () => {
    const { container } = renderMarkdown("> The water flows evenly.");
    const quote = container.querySelector("blockquote");
    expect(quote).toHaveClass("font-serif", "italic", "text-[25px]");
    expect(quote?.className).not.toMatch(/border-l|bg-/);
    const mark = quote?.querySelector("[data-quote-mark]");
    expect(mark).toHaveTextContent("“");
    expect(mark).toHaveClass("text-accent");
    expect(mark).toHaveAttribute("contenteditable", "false");
  });
});

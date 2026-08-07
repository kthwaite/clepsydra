import { render, screen } from "@testing-library/react";
import { createEditor, type Descendant } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { renderElement } from "#/editor/elements/renderElement";
import { withSchema } from "../withSchema";

function renderJournalTime() {
  const editor = withReact(withSchema(createEditor()));
  const value: Descendant[] = [
    {
      type: "journal-time",
      time: "09:07",
      children: [{ text: "" }],
    },
  ];
  render(
    <Slate editor={editor} initialValue={value}>
      <Editable renderElement={renderElement} />
    </Slate>,
  );
  return editor;
}

describe("JournalTimeHeading", () => {
  it("renders an atomic semantic heading with an accessible delete action", () => {
    renderJournalTime();

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Time heading, 09:07 local time",
    });
    expect(heading.closest("[contenteditable=false]")).not.toBeNull();
    expect(heading.querySelector("time")?.getAttribute("datetime")).toBe(
      "09:07",
    );
    expect(
      screen.getByRole("button", { name: "Delete time heading 09:07" }),
    ).toBeDefined();
  });
});

import { render, screen } from "@testing-library/react";
import { createEditor, type Descendant } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it } from "vitest";
import { renderElement } from "#/editor/elements/renderElement";
import { JournalDateProvider } from "#/editor/journalContext";
import { withSchema } from "../withSchema";

function renderJournalTime(
  element: { time: string; date?: string } = { time: "09:07" },
  journalDate: string | null = null,
) {
  const editor = withReact(withSchema(createEditor()));
  const value: Descendant[] = [
    {
      type: "journal-time",
      ...element,
      children: [{ text: "" }],
    },
  ];
  render(
    <JournalDateProvider date={journalDate}>
      <Slate editor={editor} initialValue={value}>
        <Editable renderElement={renderElement} />
      </Slate>
    </JournalDateProvider>,
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

  it("shows the date before the time on a dated heading outside a journal", () => {
    renderJournalTime({ date: "2026-09-08", time: "14:32" });

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Time heading, 2026-09-08 14:32 local time",
    });
    const time = heading.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-09-08 14:32");
    expect(time?.textContent).toBe("2026-09-08 14:32");
    expect(
      screen.getByRole("button", {
        name: "Delete time heading 2026-09-08 14:32",
      }),
    ).toBeDefined();
  });

  it("hides the date when it matches the surrounding journal's date", () => {
    renderJournalTime({ date: "2026-09-08", time: "14:32" }, "2026-09-08");

    const heading = screen.getByRole("heading", {
      level: 2,
      name: "Time heading, 2026-09-08 14:32 local time",
    });
    const time = heading.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe("2026-09-08 14:32");
    expect(time?.textContent).toBe("14:32");
  });

  it("keeps showing the date when it differs from the journal's date", () => {
    renderJournalTime({ date: "2026-09-07", time: "14:32" }, "2026-09-08");

    const time = screen
      .getByRole("heading", { level: 2 })
      .querySelector("time");
    expect(time?.textContent).toBe("2026-09-07 14:32");
  });
});

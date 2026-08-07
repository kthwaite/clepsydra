import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PageEditorHeader } from "#/editor/PageEditorHeader";

const baseProps = {
  path: "journals/2026-08-07.md",
  title: "2026-08-07",
  onTitleChange: vi.fn(),
  tags: [] as string[],
  onTagsChange: vi.fn(),
  aliases: [] as string[],
  onAliasesChange: vi.fn(),
};

describe("PageEditorHeader read-only title", () => {
  it("renders a static heading and no title input when readOnlyTitle is set", () => {
    render(
      <PageEditorHeader {...baseProps} readOnlyTitle="Friday 7 August 2026" />,
    );
    expect(
      screen.getByRole("heading", { name: "Friday 7 August 2026" }),
    ).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("2026-08-07.md")).toBeNull();
  });

  it("keeps the editable input when readOnlyTitle is absent", () => {
    const onTitleChange = vi.fn();
    render(<PageEditorHeader {...baseProps} onTitleChange={onTitleChange} />);
    const input = screen.getByDisplayValue("2026-08-07");
    fireEvent.change(input, { target: { value: "renamed" } });
    expect(onTitleChange).toHaveBeenCalledWith("renamed");
  });
});

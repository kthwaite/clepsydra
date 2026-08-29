import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { PageEditorHeader } from "#/editor/PageEditorHeader";

const baseProps = {
  path: "journals/2026-08-07.md",
  title: "2026-08-07",
  onTitleChange: vi.fn(),
  tags: [] as string[],
  tagSuggestions: [] as string[],
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

  it("keeps the editable title field when readOnlyTitle is absent", () => {
    const onTitleChange = vi.fn();
    render(<PageEditorHeader {...baseProps} onTitleChange={onTitleChange} />);
    const titleField = screen.getByDisplayValue("2026-08-07");
    fireEvent.change(titleField, { target: { value: "renamed" } });
    expect(onTitleChange).toHaveBeenCalledWith("renamed");
  });

  it("renders derived tags as immutable while ordinary tags remain editable", async () => {
    const user = userEvent.setup();
    const onTagsChange = vi.fn();
    render(
      <PageEditorHeader
        {...baseProps}
        tags={["pkm"]}
        derivedTags={["journal"]}
        onTagsChange={onTagsChange}
      />,
    );

    expect(screen.getByText("journal")).toBeInTheDocument();
    expect(screen.getByText("pkm")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);

    await user.click(screen.getByRole("button"));

    expect(onTagsChange).toHaveBeenCalledWith([]);
  });

  it("offers vault suggestions only for tags", async () => {
    const user = userEvent.setup();
    render(
      <PageEditorHeader
        {...baseProps}
        aliases={["existing alias"]}
        tagSuggestions={["research"]}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "res");
    expect(
      screen.getByRole("option", { name: "research" }),
    ).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.type(
      screen.getByRole("textbox", { name: "Add aliases" }),
      "res",
    );
    expect(screen.queryByRole("option", { name: "research" })).toBeNull();
  });

  it("awaits coordinated manual locking and reports a refused lock", async () => {
    const user = userEvent.setup();
    const onRequestLock = vi.fn().mockResolvedValue(false);
    render(
      <PageEditorHeader
        {...baseProps}
        encrypted
        onRequestLock={onRequestLock}
      />,
    );

    await user.click(
      screen.getByRole("button", { name: "Lock encrypted notes" }),
    );
    expect(onRequestLock).toHaveBeenCalledOnce();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Unable to lock while an editor has unsaved changes",
    );
  });

  it("wraps a complete title at every viewport while retaining save semantics", () => {
    const longTitle =
      "A complete title that must remain visible on a narrow mobile folio";
    const onTitleChange = vi.fn();
    const onSaveNow = vi.fn();
    render(
      <PageEditorHeader
        {...baseProps}
        title={longTitle}
        onTitleChange={onTitleChange}
        onSaveNow={onSaveNow}
      />,
    );

    const title = screen.getByRole("textbox", { name: "Page title" });
    expect(title).toHaveValue(longTitle);
    expect(title.tagName).toBe("TEXTAREA");
    expect(title).toHaveAttribute("rows", "1");
    expect(title).toHaveClass(
      "field-sizing-content",
      "overflow-hidden",
      "whitespace-pre-wrap",
      "break-words",
    );
    expect(title).not.toHaveClass(
      "md:field-sizing-fixed",
      "md:whitespace-nowrap",
      "md:break-normal",
      "md:overflow-x-auto",
    );

    expect(fireEvent.keyDown(title, { key: "Enter" })).toBe(false);
    fireEvent.change(title, { target: { value: "Reframed title" } });
    fireEvent.blur(title);

    expect(onTitleChange).toHaveBeenCalledWith("Reframed title");
    expect(onSaveNow).toHaveBeenCalledOnce();
  });

  it("strips CR and LF from multiline title changes", () => {
    const onTitleChange = vi.fn();
    render(<PageEditorHeader {...baseProps} onTitleChange={onTitleChange} />);

    fireEvent.change(screen.getByRole("textbox", { name: "Page title" }), {
      target: { value: "First line\r\nSecond line\nThird line\rFourth line" },
    });

    expect(onTitleChange).toHaveBeenCalledWith(
      "First lineSecond lineThird lineFourth line",
    );
  });

  it("allows Enter while an IME composition is active", () => {
    const onTitleChange = vi.fn();
    render(<PageEditorHeader {...baseProps} onTitleChange={onTitleChange} />);

    const title = screen.getByRole("textbox", { name: "Page title" });
    expect(fireEvent.keyDown(title, { key: "Enter", isComposing: true })).toBe(
      true,
    );
    expect(onTitleChange).not.toHaveBeenCalled();
  });

  it("renders a Raw Markdown icon button when onOpenRawMarkdown is set, and calls it on click", async () => {
    const user = userEvent.setup();
    const onOpenRawMarkdown = vi.fn();
    render(
      <PageEditorHeader {...baseProps} onOpenRawMarkdown={onOpenRawMarkdown} />,
    );

    const button = screen.getByRole("button", { name: "Raw Markdown" });
    await user.click(button);

    expect(onOpenRawMarkdown).toHaveBeenCalledOnce();
  });

  it("renders no Raw Markdown button when onOpenRawMarkdown is absent", () => {
    render(<PageEditorHeader {...baseProps} />);

    expect(screen.queryByRole("button", { name: "Raw Markdown" })).toBeNull();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { RawMarkdownEditor } from "./RawMarkdownEditor";

function ControlledRawEditor({
  initialValue,
  diagnostic,
  onApply,
  onCancel,
}: {
  initialValue: string;
  diagnostic?: string;
  onApply: () => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  return (
    <RawMarkdownEditor
      value={value}
      diagnostic={diagnostic}
      onChange={setValue}
      onApply={onApply}
      onCancel={onCancel}
    />
  );
}

describe("RawMarkdownEditor", () => {
  it("keeps exact controlled Markdown and exposes explicit Apply and Cancel actions", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onCancel = vi.fn();
    const exactInitial = "  # Draft  \n\n";
    const exactChanged = "  # Draft  \n\n- [ ] keep\t\n";

    render(
      <ControlledRawEditor
        initialValue={exactInitial}
        onApply={onApply}
        onCancel={onCancel}
      />,
    );

    const textarea = screen.getByRole("textbox", { name: "Raw Markdown" });
    expect(textarea).toHaveValue(exactInitial);
    fireEvent.change(textarea, { target: { value: exactChanged } });
    expect(textarea).toHaveValue(exactChanged);

    await user.click(screen.getByRole("button", { name: "Apply" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApply).toHaveBeenCalledOnce();
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("associates an actionable diagnostic with the mobile-usable raw textarea", () => {
    render(
      <ControlledRawEditor
        initialValue="Keep this exact text\n"
        diagnostic="Raw Markdown could not be applied. Fix line 2 and try again."
        onApply={() => {}}
        onCancel={() => {}}
      />,
    );

    const diagnostic = screen.getByRole("alert");
    const textarea = screen.getByRole("textbox", { name: "Raw Markdown" });
    expect(diagnostic).toHaveTextContent(/Fix line 2 and try again/);
    expect(textarea).toHaveAccessibleDescription(
      "Raw Markdown could not be applied. Fix line 2 and try again.",
    );
    expect(textarea).toHaveClass("w-full");
    expect(screen.getByRole("button", { name: "Apply" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeVisible();
  });
});

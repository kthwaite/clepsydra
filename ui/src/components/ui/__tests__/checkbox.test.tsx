import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Checkbox } from "#/components/ui/checkbox";

describe("Checkbox", () => {
  it("changes controlled selection and exposes help text", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Checkbox
        isSelected={false}
        onChange={onChange}
        description="Stored locally"
      >
        Encrypt note
      </Checkbox>,
    );
    const checkbox = screen.getByRole("checkbox", { name: "Encrypt note" });
    expect(checkbox).toHaveAccessibleDescription("Stored locally");
    await user.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("renders selected and indeterminate states", () => {
    const { rerender } = render(<Checkbox isSelected>Selected</Checkbox>);
    expect(screen.getByRole("checkbox", { name: "Selected" })).toBeChecked();
    rerender(<Checkbox isIndeterminate>Mixed</Checkbox>);
    expect(screen.getByRole("checkbox", { name: "Mixed" })).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
  });

  it("associates an invalid error with the checkbox", () => {
    render(
      <Checkbox isInvalid errorMessage="Required">
        Consent
      </Checkbox>,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Consent" });
    expect(checkbox).toHaveAttribute("aria-invalid", "true");
    expect(checkbox).toHaveAccessibleDescription("Required");
  });

  it("does not call onChange for disabled pointer or keyboard interaction", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Checkbox isDisabled onChange={onChange}>
        Locked
      </Checkbox>,
    );

    const checkbox = screen.getByRole("checkbox", { name: "Locked" });
    expect(checkbox).toBeDisabled();

    await user.click(checkbox);
    expect(onChange).not.toHaveBeenCalled();

    await user.tab();
    expect(checkbox).not.toHaveFocus();
    await user.keyboard(" ");
    expect(onChange).not.toHaveBeenCalled();
  });
});

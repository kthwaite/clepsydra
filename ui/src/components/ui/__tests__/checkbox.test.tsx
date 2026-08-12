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

  it("renders selected, indeterminate, invalid, and disabled states", () => {
    const { rerender } = render(<Checkbox isSelected>Selected</Checkbox>);
    expect(screen.getByRole("checkbox", { name: "Selected" })).toBeChecked();
    rerender(<Checkbox isIndeterminate>Mixed</Checkbox>);
    expect(screen.getByRole("checkbox", { name: "Mixed" })).toHaveAttribute(
      "aria-checked",
      "mixed",
    );
    rerender(
      <Checkbox isInvalid errorMessage="Required">
        Consent
      </Checkbox>,
    );
    expect(screen.getByText("Required")).toBeVisible();
    rerender(<Checkbox isDisabled>Locked</Checkbox>);
    expect(screen.getByRole("checkbox", { name: "Locked" })).toBeDisabled();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CheckboxGroup } from "#/components/ui/checkbox-group";
import { Checkbox } from "#/components/ui/checkbox";

describe("CheckboxGroup", () => {
  it("updates the selected value array", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <CheckboxGroup
        label="Notifications"
        value={["security"]}
        onChange={onChange}
      >
        <Checkbox value="product">Product</Checkbox>
        <Checkbox value="security">Security</Checkbox>
      </CheckboxGroup>,
    );
    expect(
      screen.getByRole("group", { name: "Notifications" }),
    ).toBeVisible();
    await user.click(screen.getByRole("checkbox", { name: "Product" }));
    expect(onChange).toHaveBeenCalledWith(["security", "product"]);
  });

  it("exposes orientation, description, error, and disabled children", () => {
    render(
      <CheckboxGroup
        label="Kinds"
        orientation="horizontal"
        description="Choose one"
        isInvalid
        errorMessage="Required"
        isDisabled
      >
        <Checkbox value="note">Note</Checkbox>
      </CheckboxGroup>,
    );
    expect(screen.getByRole("group", { name: "Kinds" })).toHaveAttribute(
      "data-orientation",
      "horizontal",
    );
    expect(screen.getByText("Choose one")).toBeVisible();
    expect(screen.getByText("Required")).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Note" })).toBeDisabled();
  });
});

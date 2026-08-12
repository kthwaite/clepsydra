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

  it("exposes orientation, messaging associations, and disabled children", () => {
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
    const group = screen.getByRole("group", { name: "Kinds" });
    expect(group).toHaveAttribute("data-orientation", "horizontal");
    expect(group).toHaveAccessibleDescription("Choose one Required");
    expect(screen.getByRole("checkbox", { name: "Note" })).toBeDisabled();
  });

  it("blocks form submission and reports an empty required group", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <CheckboxGroup
          label="Kinds"
          name="kinds"
          isRequired
          errorMessage="Choose at least one"
        >
          <Checkbox value="note">Note</Checkbox>
          <Checkbox value="task">Task</Checkbox>
        </CheckboxGroup>
        <button type="submit">Continue</button>
      </form>,
    );

    const group = screen.getByRole("group", { name: "Kinds" });
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(group).toHaveAttribute("data-invalid", "true");
    expect(group).toHaveAccessibleDescription("Choose at least one");

    await user.click(screen.getByRole("checkbox", { name: "Note" }));
    await user.click(screen.getByRole("button", { name: "Continue" }));

    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Switch } from "#/components/ui/switch";

describe("Switch", () => {
  it("is a labelled switch that toggles", async () => {
    const onChange = vi.fn();
    render(<Switch onChange={onChange}>Compact</Switch>);
    const sw = screen.getByRole("switch", { name: "Compact" });
    expect(sw).not.toBeChecked();
    await userEvent.setup().click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("reflects a controlled selection", () => {
    render(<Switch isSelected>Compact</Switch>);
    expect(screen.getByRole("switch", { name: "Compact" })).toBeChecked();
  });
});

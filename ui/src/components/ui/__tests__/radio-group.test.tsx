import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Radio, RadioGroup } from "#/components/ui/radio-group";

describe("RadioGroup", () => {
  it("renders label and radios", () => {
    render(
      <RadioGroup label="Mode">
        <Radio value="a">Alpha</Radio>
        <Radio value="b">Beta</Radio>
      </RadioGroup>,
    );
    expect(screen.getByText("Mode")).toBeDefined();
    expect(screen.getByRole("radio", { name: "Alpha" })).toBeDefined();
    expect(screen.getByRole("radio", { name: "Beta" })).toBeDefined();
  });

  it("selects default value", () => {
    render(
      <RadioGroup label="Mode" defaultValue="b">
        <Radio value="a">Alpha</Radio>
        <Radio value="b">Beta</Radio>
      </RadioGroup>,
    );
    expect(
      (screen.getByRole("radio", { name: "Beta" }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("fires onChange on selection", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <RadioGroup label="Mode" value="a" onChange={handler}>
        <Radio value="a">Alpha</Radio>
        <Radio value="b">Beta</Radio>
      </RadioGroup>,
    );
    await user.click(screen.getByRole("radio", { name: "Beta" }));
    expect(handler).toHaveBeenCalledWith("b");
  });

  it("renders description", () => {
    render(
      <RadioGroup label="Mode" description="Pick one">
        <Radio value="a">Alpha</Radio>
      </RadioGroup>,
    );
    expect(screen.getByText("Pick one")).toBeDefined();
  });
});

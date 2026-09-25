import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "#/components/ui/segmented-control";

describe("SegmentedControl", () => {
  it("exposes a named radio group and updates by keyboard", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        label="Mode"
        value="dark"
        options={[
          { id: "dark", label: "Dark" },
          { id: "light", label: "Paper" },
        ]}
        onChange={onChange}
      />,
    );

    expect(screen.getByRole("radiogroup", { name: "Mode" })).toBeVisible();
    const dark = screen.getByRole("radio", { name: "Dark" });
    expect(dark).toBeChecked();
    dark.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith("light");
  });

  it("keeps visuals display-only and uses the text label as the radio name", () => {
    render(
      <SegmentedControl
        label="Accent"
        value="alert"
        options={[
          {
            id: "alert",
            label: "Alert",
            visual: <span data-testid="swatch" />,
          },
        ]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByRole("radio", { name: "Alert" })).toBeChecked();
    expect(screen.getByTestId("swatch").parentElement).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("sits on a sink track and raises the selected segment", () => {
    render(
      <SegmentedControl
        label="Mode"
        value="a"
        options={[
          { id: "a", label: "Alpha" },
          { id: "b", label: "Beta" },
        ]}
        onChange={() => {}}
      />,
    );
    const group = screen.getByRole("radiogroup", { name: "Mode" });
    expect(group.querySelector("[data-slot=segment-track]")).toHaveClass(
      "bg-sink",
      "rounded-full",
    );
    const alpha = screen.getByRole("radio", { name: "Alpha" }).closest("label");
    expect(alpha).toHaveClass("data-[selected]:bg-raise");
    expect(alpha?.className ?? "").not.toMatch(/uppercase|tracking-/);
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindSelect } from "#/components/codex/KindSelect";

describe("KindSelect", () => {
  it("renders the current kind label", () => {
    render(<KindSelect value="QUOTE" inferred={false} onAssign={() => {}} />);
    // The Select trigger carries aria-label="Kind"; its visible label renders
    // as the button's text content. Scope to that trigger so the assertion
    // targets only the visible control, not react-aria's hidden autofill
    // <option> (which also reads "QUOTE").
    expect(screen.getByRole("button", { name: "Kind" })).toHaveTextContent(
      "QUOTE",
    );
  });

  it("renders an immutable kind without opening or assigning", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(
      <KindSelect
        value="JOURNAL"
        inferred={false}
        immutableReason="Journal kind cannot be changed."
        onAssign={onAssign}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Kind" });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("JOURNAL");
    expect(trigger).toHaveTextContent("fixed");
    expect(trigger).toHaveAccessibleDescription(
      "Journal kind cannot be changed.",
    );
    await user.click(trigger);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("keeps ordinary kinds assignable", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<KindSelect value="NOTE" inferred={false} onAssign={onAssign} />);
    await user.click(screen.getByRole("button", { name: "Kind" }));
    await user.click(screen.getByRole("option", { name: "QUOTE" }));
    expect(onAssign).toHaveBeenCalledWith("QUOTE");
  });
});

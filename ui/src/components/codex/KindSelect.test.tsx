import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindSelect } from "#/components/codex/KindSelect";

describe("KindSelect", () => {
  it("renders an existing quotation kind without offering it for assignment", async () => {
    const user = userEvent.setup();
    render(<KindSelect value="QUOTE" inferred={false} onAssign={() => {}} />);

    const trigger = screen.getByRole("button", { name: "Kind" });
    expect(trigger).toHaveTextContent("QUOTE");

    await user.click(trigger);
    expect(screen.queryByRole("option", { name: "QUOTE" })).toBeNull();
    expect(screen.getByRole("option", { name: "NOTE" })).toBeVisible();
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
    await user.click(screen.getByRole("option", { name: "BOOK" }));
    expect(onAssign).toHaveBeenCalledWith("BOOK");
  });
});

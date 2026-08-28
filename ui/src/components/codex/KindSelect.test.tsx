import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindSelect } from "#/components/codex/KindSelect";

const ALPHABETICAL_LABELS = [
  "1:1",
  "AI CONVERSATION",
  "AI JOURNAL",
  "ARCHIVE",
  "BOOK",
  "CAPTURE",
  "CODE",
  "CYCLE",
  "JOURNAL",
  "MEETING",
  "NOTE",
  "PERSON",
  "PROJECT",
  "RECIPE",
  "TASK",
  "TODO",
];

describe("KindSelect", () => {
  it("renders the current kind in a combobox input", () => {
    render(<KindSelect value="NOTE" inferred={false} onAssign={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Kind" })).toHaveValue("NOTE");
  });

  it("lists assignable kinds alphabetically by label, without quotation", async () => {
    const user = userEvent.setup();
    render(<KindSelect value="QUOTE" inferred={false} onAssign={() => {}} />);

    const input = screen.getByRole("combobox", { name: "Kind" });
    expect(input).toHaveValue("QUOTE");

    await user.click(input);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(ALPHABETICAL_LABELS);
  });

  it("assigns a kind picked from the list", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<KindSelect value="NOTE" inferred={false} onAssign={onAssign} />);

    await user.click(screen.getByRole("combobox", { name: "Kind" }));
    await user.click(await screen.findByRole("option", { name: "BOOK" }));
    expect(onAssign).toHaveBeenCalledWith("BOOK");
  });

  it("filters options as the user types", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<KindSelect value="NOTE" inferred={false} onAssign={onAssign} />);

    const input = screen.getByRole("combobox", { name: "Kind" });
    await user.clear(input);
    await user.type(input, "bo");

    expect(await screen.findByRole("option", { name: "BOOK" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "NOTE" })).toBeNull();

    await user.click(screen.getByRole("option", { name: "BOOK" }));
    expect(onAssign).toHaveBeenCalledWith("BOOK");
  });

  it("reverts unmatched text on blur without assigning", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(
      <div>
        <KindSelect value="NOTE" inferred={false} onAssign={onAssign} />
        <button type="button">Outside</button>
      </div>,
    );

    const input = screen.getByRole("combobox", { name: "Kind" });
    await user.clear(input);
    await user.type(input, "zzz");
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(input).toHaveValue("NOTE");
    expect(onAssign).not.toHaveBeenCalled();
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

    const input = screen.getByRole("combobox", { name: "Kind" });
    expect(input).toBeDisabled();
    expect(input).toHaveValue("JOURNAL");
    expect(input).toHaveAccessibleDescription(
      "Journal kind cannot be changed.",
    );
    expect(screen.getByText("· fixed")).toBeInTheDocument();

    await user.click(input);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("annotates an inferred kind", () => {
    render(<KindSelect value="NOTE" inferred onAssign={() => {}} />);
    expect(screen.getByText("· inferred")).toBeInTheDocument();
  });

  it("supports an empty value with a placeholder for bulk actions", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(
      <KindSelect
        value={null}
        inferred={false}
        placeholder="Set kind…"
        onAssign={onAssign}
      />,
    );

    const input = screen.getByRole("combobox", { name: "Kind" });
    expect(input).toHaveValue("");
    expect(input).toHaveAttribute("placeholder", "Set kind…");

    await user.click(input);
    await user.click(await screen.findByRole("option", { name: "BOOK" }));

    expect(onAssign).toHaveBeenCalledWith("BOOK");
    expect(input).toHaveValue("");
  });
});

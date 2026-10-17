import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KindSelect } from "#/components/codex/KindSelect";

const ALPHABETICAL_LABELS = [
  "AI conversation",
  "AI journal",
  "Archive",
  "Book",
  "Capture",
  "Code",
  "Cycle",
  "Journal",
  "Meeting",
  "Note",
  "Person",
  "Project",
  "Recipe",
  "Task",
  "Todo",
];

describe("KindSelect", () => {
  it("renders the current kind in sentence case in a combobox input", () => {
    render(<KindSelect value="NOTE" inferred={false} onAssign={() => {}} />);
    expect(screen.getByRole("combobox", { name: "Kind" })).toHaveValue("Note");
  });

  it("keeps AI capitalised in the sentence-case kind label", () => {
    render(
      <KindSelect value="AI_JOURNAL" inferred={false} onAssign={() => {}} />,
    );
    expect(screen.getByRole("combobox", { name: "Kind" })).toHaveValue(
      "AI journal",
    );
  });

  it("lists assignable kinds alphabetically by label, without quotation", async () => {
    const user = userEvent.setup();
    render(<KindSelect value="QUOTE" inferred={false} onAssign={() => {}} />);

    const input = screen.getByRole("combobox", { name: "Kind" });
    expect(input).toHaveValue("Quote");

    await user.click(input);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(ALPHABETICAL_LABELS);
  });

  it("assigns a kind picked from the list", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<KindSelect value="NOTE" inferred={false} onAssign={onAssign} />);

    await user.click(screen.getByRole("combobox", { name: "Kind" }));
    await user.click(await screen.findByRole("option", { name: "Book" }));
    expect(onAssign).toHaveBeenCalledWith("BOOK");
  });

  it("filters options as the user types", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<KindSelect value="NOTE" inferred={false} onAssign={onAssign} />);

    const input = screen.getByRole("combobox", { name: "Kind" });
    await user.clear(input);
    await user.type(input, "bo");

    expect(await screen.findByRole("option", { name: "Book" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Note" })).toBeNull();

    await user.click(screen.getByRole("option", { name: "Book" }));
    expect(onAssign).toHaveBeenCalledWith("BOOK");
  });

  it.each(["Enter", "Tab"])(
    "commits the unique filtered kind on %s",
    async (key) => {
      const user = userEvent.setup();
      const onAssign = vi.fn();
      render(
        <>
          <KindSelect value="NOTE" inferred={false} onAssign={onAssign} />
          <button type="button">Outside</button>
        </>,
      );
      const input = screen.getByRole("combobox", { name: "Kind" });
      await user.clear(input);
      await user.type(input, "eet");
      await user.keyboard(`{${key}}`);
      expect(onAssign).toHaveBeenCalledExactlyOnceWith("MEETING");
      if (key === "Tab")
        expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
      else expect(screen.getByRole("combobox", { name: "Kind" })).toHaveFocus();
    },
  );

  it.each(["Enter", "Tab"])(
    "resolves the current kind's prefix on %s without reassigning it",
    async (key) => {
      const user = userEvent.setup();
      const onAssign = vi.fn();
      render(
        <>
          <KindSelect value="MEETING" inferred={false} onAssign={onAssign} />
          <button type="button">Outside</button>
        </>,
      );
      const input = screen.getByRole("combobox", { name: "Kind" });
      await user.clear(input);
      await user.type(input, "mee");
      await user.keyboard(`{${key}}`);
      expect(input).toHaveValue("Meeting");
      expect(onAssign).not.toHaveBeenCalled();
      if (key === "Tab")
        expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
      else expect(input).toHaveFocus();
    },
  );

  it.each(["Enter", "Tab"])(
    "does not guess among multiple kind matches on %s",
    async (key) => {
      const user = userEvent.setup();
      const onAssign = vi.fn();
      render(
        <>
          <KindSelect value="NOTE" inferred={false} onAssign={onAssign} />
          <button type="button">Outside</button>
        </>,
      );
      const input = screen.getByRole("combobox", { name: "Kind" });
      await user.clear(input);
      await user.type(input, "o");
      await user.keyboard(`{${key}}`);
      expect(onAssign).not.toHaveBeenCalled();
      if (key === "Tab")
        expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    },
  );

  it.each(["Enter", "Tab"])(
    "does not assign an unknown kind on %s",
    async (key) => {
      const user = userEvent.setup();
      const onAssign = vi.fn();
      render(
        <>
          <KindSelect value="NOTE" inferred={false} onAssign={onAssign} />
          <button type="button">Outside</button>
        </>,
      );
      const input = screen.getByRole("combobox", { name: "Kind" });
      await user.clear(input);
      await user.type(input, "ghost");
      await user.keyboard(`{${key}}`);
      expect(onAssign).not.toHaveBeenCalled();
      if (key === "Tab")
        expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    },
  );

  it("does not commit an IME confirmation", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<KindSelect value="NOTE" inferred={false} onAssign={onAssign} />);
    const input = screen.getByRole("combobox", { name: "Kind" });
    await user.clear(input);
    await user.type(input, "eet");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("clears the filter without unassigning the kind and keeps typing focus", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(<KindSelect value="NOTE" inferred={false} onAssign={onAssign} />);
    await user.click(screen.getByRole("button", { name: "Clear kind" }));
    const input = screen.getByRole("combobox", { name: "Kind" });
    expect(input).toHaveValue("");
    expect(input).toHaveFocus();
    expect(onAssign).not.toHaveBeenCalled();
    await user.type(input, "eet{Enter}");
    expect(onAssign).toHaveBeenCalledExactlyOnceWith("MEETING");
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

    expect(input).toHaveValue("Note");
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
    expect(input).toHaveValue("Journal");
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
    await user.click(await screen.findByRole("option", { name: "Book" }));

    expect(onAssign).toHaveBeenCalledWith("BOOK");
    expect(input).toHaveValue("");
  });

  it("allows the same kind in successive bulk operations without duplicating either pick on blur", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(
      <>
        <KindSelect value={null} inferred={false} onAssign={onAssign} />
        <button type="button">Outside</button>
      </>,
    );
    const input = screen.getByRole("combobox", { name: "Kind" });
    const outside = screen.getByRole("button", { name: "Outside" });
    for (const count of [1, 2]) {
      await user.click(input);
      await user.click(await screen.findByRole("option", { name: "Book" }));
      await user.click(outside);
      expect(onAssign).toHaveBeenCalledTimes(count);
      expect(onAssign).toHaveBeenLastCalledWith("BOOK");
      expect(input).toHaveValue("");
    }
  });

  it("allows repeating a keyboard bulk assignment after focus traversal", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(
      <>
        <KindSelect value={null} inferred={false} onAssign={onAssign} />
        <button type="button">Outside</button>
      </>,
    );
    const input = screen.getByRole("combobox", { name: "Kind" });
    for (const count of [1, 2]) {
      await user.type(input, "boo");
      await user.tab();
      expect(onAssign).toHaveBeenCalledTimes(count);
      expect(onAssign).toHaveBeenLastCalledWith("BOOK");
      expect(input).toHaveValue("");
      expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
    }
  });

  it("can retry a kind assignment when the authoritative value remains unchanged", async () => {
    const user = userEvent.setup();
    const onAssign = vi.fn();
    render(
      <>
        <KindSelect value="NOTE" inferred={false} onAssign={onAssign} />
        <button type="button">Outside</button>
      </>,
    );
    const input = screen.getByRole("combobox", { name: "Kind" });
    const outside = screen.getByRole("button", { name: "Outside" });
    for (const count of [1, 2]) {
      await user.clear(input);
      await user.type(input, "boo");
      await user.click(await screen.findByRole("option", { name: "Book" }));
      await user.click(outside);
      // A refused save leaves the authoritative value as NOTE. A later
      // deliberate choice must retry, not echo the previous interaction.
      expect(onAssign).toHaveBeenCalledTimes(count);
      expect(onAssign).toHaveBeenLastCalledWith("BOOK");
      expect(input).toHaveValue("Note");
    }
  });
});

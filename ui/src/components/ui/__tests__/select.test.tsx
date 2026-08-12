import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import type { Key } from "react-aria-components/Select";
import { describe, expect, it, vi } from "vitest";
import {
  Select,
  SelectItem,
  SelectListBox,
} from "#/components/ui/select";

describe("Select", () => {
  it("opens and reports a selected key", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(
      <Select
        label="Status"
        placeholder="Choose status"
        onSelectionChange={onSelectionChange}
      >
        <SelectItem id="unread">Unread</SelectItem>
        <SelectItem id="done">Done</SelectItem>
      </Select>,
    );

    const trigger = screen.getByRole("button", { name: /Status/ });
    expect(trigger).toHaveTextContent("Choose status");
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Done" }));

    expect(onSelectionChange).toHaveBeenCalledWith("done");
    expect(trigger).toHaveTextContent("Done");
  });

  it("updates a controlled selection", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function ControlledSelect() {
      const [value, setValue] = useState<Key | null>("unread");
      return (
        <Select
          label="Status"
          value={value}
          onChange={(key) => {
            onChange(key);
            setValue(key);
          }}
        >
          <SelectItem id="unread">Unread</SelectItem>
          <SelectItem id="done">Done</SelectItem>
        </Select>
      );
    }

    render(<ControlledSelect />);
    const trigger = screen.getByRole("button", { name: /Status/ });
    expect(trigger).toHaveTextContent("Unread");
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Done" }));

    expect(onChange).toHaveBeenCalledWith("done");
    expect(trigger).toHaveTextContent("Done");
  });

  it("selects the first option with ArrowDown and Enter", async () => {
    const user = userEvent.setup();
    const onSelectionChange = vi.fn();
    render(
      <Select label="Status" onSelectionChange={onSelectionChange}>
        <SelectItem id="unread">Unread</SelectItem>
        <SelectItem id="done">Done</SelectItem>
      </Select>,
    );

    const trigger = screen.getByRole("button", { name: /Status/ });
    trigger.focus();
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onSelectionChange).toHaveBeenCalledWith("unread");
    expect(trigger).toHaveTextContent("Unread");
  });

  it("supports dynamic items and field messaging", () => {
    const items = [
      { id: "a", name: "Alpha" },
      { id: "b", name: "Beta" },
    ];
    render(
      <Select
        label="Letter"
        items={items}
        description="Pick one"
        isInvalid
        errorMessage="Required"
      >
        {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
      </Select>,
    );

    const trigger = screen.getByRole("button", { name: /Letter/ });
    expect(trigger).toHaveAccessibleDescription("Pick one Required");
  });

  it("does not open when disabled", async () => {
    const user = userEvent.setup();
    render(
      <Select aria-label="Status" isDisabled>
        <SelectItem id="done">Done</SelectItem>
      </Select>,
    );

    const trigger = screen.getByRole("button", { name: /Status/ });
    expect(trigger).toBeDisabled();
    await user.click(trigger);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("composes caller classes with the shared Select contracts", async () => {
    const user = userEvent.setup();
    render(
      <Select
        label="Status"
        className={({ isInvalid }) =>
          isInvalid ? "caller-invalid" : "caller-root"
        }
      >
        <SelectItem id="done">Done</SelectItem>
      </Select>,
    );

    const trigger = screen.getByRole("button", { name: /Status/ });
    const root = trigger.closest(".caller-root");
    expect(root).toHaveClass("group", "relative", "w-full");
    expect(trigger).toHaveClass("w-full", "text-start");
    expect(trigger.querySelector("svg")).toHaveAttribute("aria-hidden", "true");

    await user.click(trigger);
    expect(screen.getByRole("listbox")).toHaveClass(
      "max-h-64",
      "overflow-auto",
      "outline-none",
    );
    expect(document.querySelector(".react-aria-Popover")).toHaveClass(
      "border-border",
      "bg-popover",
      "shadow-lg",
    );
  });

  it("composes ListBox and item render-prop classes with option states", () => {
    render(
      <SelectListBox
        aria-label="Standalone"
        selectionMode="single"
        defaultSelectedKeys={["one"]}
        disabledKeys={["two"]}
        className={({ isEmpty }) =>
          isEmpty ? "caller-empty" : "caller-listbox"
        }
      >
        <SelectItem
          id="one"
          className={({ isSelected }) =>
            isSelected ? "caller-selected" : "caller-unselected"
          }
        >
          One
        </SelectItem>
        <SelectItem id="two" className="caller-disabled">
          Two
        </SelectItem>
      </SelectListBox>,
    );

    expect(screen.getByRole("listbox", { name: "Standalone" })).toHaveClass(
      "caller-listbox",
      "max-h-64",
      "overflow-auto",
    );
    expect(screen.getByRole("option", { name: "One" })).toHaveClass(
      "caller-selected",
      "bg-accent",
    );
    expect(screen.getByRole("option", { name: "Two" })).toHaveClass(
      "caller-disabled",
      "opacity-50",
    );
  });
});

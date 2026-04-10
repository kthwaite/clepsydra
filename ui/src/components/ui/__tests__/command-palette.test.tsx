import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CommandPalette,
  CommandPaletteItem,
} from "#/components/ui/command-palette";

describe("CommandPalette", () => {
  const items = [
    { id: "1", label: "Alpha", description: "first" },
    { id: "2", label: "Beta", description: "second" },
    { id: "3", label: "Gamma", description: "third" },
  ];

  function renderPalette(props: {
    onAction?: (id: string) => void;
    onQueryChange?: (q: string) => void;
    onOpenChange?: (open: boolean) => void;
  }) {
    const onAction = props.onAction ?? vi.fn();
    return render(
      <CommandPalette
        isOpen
        onOpenChange={props.onOpenChange ?? (() => {})}
        query=""
        onQueryChange={props.onQueryChange ?? (() => {})}
        placeholder="Search..."
      >
        {items.map((item) => (
          <CommandPaletteItem
            key={item.id}
            id={item.id}
            textValue={item.label}
            onAction={() => onAction(item.id)}
          >
            <span>{item.label}</span>
            <span>{item.description}</span>
          </CommandPaletteItem>
        ))}
      </CommandPalette>,
    );
  }

  /** Focus the combobox input so keyboard events reach it. */
  async function focusInput(user: ReturnType<typeof userEvent.setup>) {
    const input = screen.getByPlaceholderText("Search...");
    await user.click(input);
    return input;
  }

  it("renders search input and items when open", () => {
    renderPalette({});
    expect(screen.getByPlaceholderText("Search...")).toBeDefined();
    expect(screen.getByText("Alpha")).toBeDefined();
    expect(screen.getByText("Beta")).toBeDefined();
    expect(screen.getByText("Gamma")).toBeDefined();
  });

  it("does not render when closed", () => {
    render(
      <CommandPalette
        isOpen={false}
        onOpenChange={() => {}}
        query=""
        onQueryChange={() => {}}
      />,
    );
    expect(screen.queryByPlaceholderText("Search...")).toBeNull();
  });

  it("highlights first item by default", () => {
    renderPalette({});
    const firstItem = screen.getByText("Alpha").closest("[role='option']");
    expect(firstItem?.getAttribute("data-focused")).toBe("true");
  });

  it("moves highlight on ArrowDown", async () => {
    const user = userEvent.setup();
    renderPalette({});
    await focusInput(user);
    await user.keyboard("{ArrowDown}");
    const secondItem = screen.getByText("Beta").closest("[role='option']");
    expect(secondItem?.getAttribute("data-focused")).toBe("true");
  });

  it("moves highlight on ArrowUp", async () => {
    const user = userEvent.setup();
    renderPalette({});
    await focusInput(user);
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowUp}");
    const firstItem = screen.getByText("Alpha").closest("[role='option']");
    expect(firstItem?.getAttribute("data-focused")).toBe("true");
  });

  it("fires onAction on Enter", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderPalette({ onAction });
    await focusInput(user);
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledWith("1");
  });

  it("fires onAction on ArrowDown then Enter", async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    renderPalette({ onAction });
    await focusInput(user);
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");
    expect(onAction).toHaveBeenCalledWith("2");
  });

  it("fires onQueryChange on typing", async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    renderPalette({ onQueryChange });
    const input = await focusInput(user);
    await user.type(input, "hello");
    // Component is controlled with query="" so each keystroke fires with
    // just the single character typed into the empty input.
    expect(onQueryChange).toHaveBeenCalledTimes(5);
    expect(onQueryChange).toHaveBeenNthCalledWith(1, "h");
    expect(onQueryChange).toHaveBeenNthCalledWith(2, "e");
    expect(onQueryChange).toHaveBeenNthCalledWith(3, "l");
    expect(onQueryChange).toHaveBeenNthCalledWith(4, "l");
    expect(onQueryChange).toHaveBeenNthCalledWith(5, "o");
  });

  it("has combobox ARIA semantics", () => {
    renderPalette({});
    const input = screen.getByPlaceholderText("Search...");
    expect(input.getAttribute("role")).toBe("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(input.getAttribute("aria-controls")).toBeTruthy();
  });
});

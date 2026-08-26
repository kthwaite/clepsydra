import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EditorSuggestionPopover } from "#/components/ui/editor-suggestion-popover";

function makeVirtualReference(left: number, top: number) {
  return {
    getBoundingClientRect: () => ({
      x: left,
      y: top,
      left,
      top,
      right: left,
      bottom: top + 18,
      width: 0,
      height: 18,
      toJSON: () => ({}),
    }),
  };
}

interface TestItem {
  id: string;
  label: string;
}

const items: TestItem[] = [
  { id: "1", label: "Alpha" },
  { id: "2", label: "Beta" },
  { id: "3", label: "Gamma" },
];

function renderPopover(
  overrides: Partial<{
    items: TestItem[];
    onSelect: (item: TestItem) => void;
    onClose: () => void;
    reference: ReturnType<typeof makeVirtualReference> | null;
    query: string;
    emptyMessage: string;
    isLoading: boolean;
  }> = {},
) {
  const defaults = {
    items,
    query: "",
    reference: makeVirtualReference(100, 100),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    renderItem: (item: TestItem) => <span>{item.label}</span>,
    getItemKey: (item: TestItem) => item.id,
  };
  const props = { ...defaults, ...overrides };
  return render(<EditorSuggestionPopover {...props} />);
}

describe("EditorSuggestionPopover", () => {
  it("does not render when reference is null", () => {
    renderPopover({ reference: null });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders listbox with items", () => {
    renderPopover();
    expect(screen.getByRole("listbox")).toBeDefined();
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(3);
  });

  it("shows empty message when items is empty", () => {
    renderPopover({ items: [], emptyMessage: "Nothing found" });
    expect(screen.getByText("Nothing found")).toBeDefined();
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("shows loading state over empty message", () => {
    renderPopover({
      items: [],
      isLoading: true,
      emptyMessage: "Nothing found",
    });
    expect(screen.getByText("Searching...")).toBeDefined();
    expect(screen.queryByText("Nothing found")).toBeNull();
  });

  it("first item is active by default", () => {
    renderPopover();
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown moves active item", () => {
    renderPopover();
    fireEvent.keyDown(document, { key: "ArrowDown", bubbles: true });
    const options = screen.getAllByRole("option");
    expect(options[1].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowUp moves active item", () => {
    renderPopover();
    fireEvent.keyDown(document, { key: "ArrowDown", bubbles: true });
    fireEvent.keyDown(document, { key: "ArrowUp", bubbles: true });
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("ArrowDown does not go past last item", () => {
    renderPopover();
    for (let i = 0; i < 5; i++) {
      fireEvent.keyDown(document, { key: "ArrowDown", bubbles: true });
    }
    const options = screen.getAllByRole("option");
    expect(options[2].getAttribute("aria-selected")).toBe("true");
  });

  it("normalizes arrow navigation after an empty result set", () => {
    const commonProps = {
      query: "same-query",
      reference: makeVirtualReference(100, 100),
      onSelect: vi.fn(),
      onClose: vi.fn(),
      renderItem: (item: TestItem) => <span>{item.label}</span>,
      getItemKey: (item: TestItem) => item.id,
    };
    const view = render(
      <EditorSuggestionPopover
        {...commonProps}
        items={[]}
        emptyMessage="Nothing found"
      />,
    );

    fireEvent.keyDown(document, { key: "ArrowDown", bubbles: true });
    view.rerender(
      <EditorSuggestionPopover {...commonProps} items={items} />,
    );
    fireEvent.keyDown(document, { key: "ArrowDown", bubbles: true });

    expect(screen.getAllByRole("option")[1]).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("Enter calls onSelect with active item", () => {
    const onSelect = vi.fn();
    renderPopover({ onSelect });
    fireEvent.keyDown(document, { key: "ArrowDown", bubbles: true });
    fireEvent.keyDown(document, { key: "Enter", bubbles: true });
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("Tab calls onSelect with active item", () => {
    const onSelect = vi.fn();
    renderPopover({ onSelect });
    fireEvent.keyDown(document, { key: "Tab", bubbles: true });
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    renderPopover({ onClose });
    fireEvent.keyDown(document, { key: "Escape", bubbles: true });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("mouseDown on item calls onSelect", () => {
    const onSelect = vi.fn();
    renderPopover({ onSelect });
    const options = screen.getAllByRole("option");
    fireEvent.mouseDown(options[1]);
    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it("mouseEnter updates active item", () => {
    renderPopover();
    const options = screen.getAllByRole("option");
    fireEvent.mouseEnter(options[2]);
    expect(options[2].getAttribute("aria-selected")).toBe("true");
  });

  it("resets selection when query changes", () => {
    const { rerender } = render(
      <EditorSuggestionPopover
        items={items}
        query="foo"
        reference={makeVirtualReference(100, 100)}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        renderItem={(item: TestItem) => <span>{item.label}</span>}
        getItemKey={(item: TestItem) => item.id}
      />,
    );
    fireEvent.keyDown(document, { key: "ArrowDown", bubbles: true });
    rerender(
      <EditorSuggestionPopover
        items={items}
        query="bar"
        reference={makeVirtualReference(100, 100)}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        renderItem={(item: TestItem) => <span>{item.label}</span>}
        getItemKey={(item: TestItem) => item.id}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
  });

  it("does not claim active descendant ownership from the editor", () => {
    renderPopover();
    const listbox = screen.getByRole("listbox");
    const options = screen.getAllByRole("option");
    expect(listbox).not.toHaveAttribute("aria-activedescendant");
    expect(options[0]).toHaveAttribute("aria-selected", "true");
  });
});

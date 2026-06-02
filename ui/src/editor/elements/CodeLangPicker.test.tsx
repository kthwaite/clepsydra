import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodeLangPicker } from "#/editor/elements/CodeLangPicker";

function renderPicker(
  overrides: Partial<{
    value: string | null;
    onSelect: (lang: string | null) => void;
    onClose: () => void;
    reference: HTMLElement | null;
  }> = {},
) {
  const props = {
    value: null,
    reference: document.createElement("button"),
    onSelect: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<CodeLangPicker {...props} />);
  return props;
}

describe("CodeLangPicker", () => {
  it("does not render when reference is null", () => {
    renderPicker({ reference: null });
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("renders a search input and a listbox", () => {
    renderPicker();
    expect(screen.getByPlaceholderText("Search language…")).toBeDefined();
    expect(screen.getByRole("listbox")).toBeDefined();
  });

  it("always offers the Plain text reset row", () => {
    renderPicker();
    expect(screen.getByText("Plain text")).toBeDefined();
  });

  it("filters the list as the query changes", () => {
    renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    expect(screen.getByText("RUST")).toBeDefined();
    expect(screen.queryByText("JAVASCRIPT")).toBeNull();
  });

  it("clicking a language calls onSelect with its id", () => {
    const { onSelect } = renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    fireEvent.mouseDown(screen.getByText("RUST"));
    expect(onSelect).toHaveBeenCalledWith("rust");
  });

  it("clicking Plain text calls onSelect with null", () => {
    const { onSelect } = renderPicker();
    fireEvent.mouseDown(screen.getByText("Plain text"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("Enter selects the active row", () => {
    const { onSelect } = renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("rust");
  });

  it("exposes the search input as a combobox", () => {
    renderPicker();
    expect(screen.getByRole("combobox")).toBeDefined();
  });

  it("Tab selects the active row", () => {
    const { onSelect } = renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    fireEvent.keyDown(input, { key: "Tab" });
    expect(onSelect).toHaveBeenCalledWith("rust");
  });

  it("Escape calls onClose", () => {
    const { onClose } = renderPicker();
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("marks the current value with a check", () => {
    renderPicker({ value: "rust" });
    const input = screen.getByPlaceholderText("Search language…");
    fireEvent.change(input, { target: { value: "rust" } });
    const option = screen.getByText("RUST").closest('[role="option"]');
    expect(option?.textContent).toContain("✓");
  });
});

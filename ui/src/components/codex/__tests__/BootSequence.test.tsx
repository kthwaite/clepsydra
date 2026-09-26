import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BootSequence } from "#/components/codex/BootSequence";
import { useUiStore } from "#/store/ui";

describe("BootSequence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useUiStore.setState({ isBooting: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    useUiStore.setState({ isBooting: false });
  });

  it("renders a calm loading state in sentence case", () => {
    render(<BootSequence />);
    const skip = screen.getByRole("button", { name: "Skip boot sequence" });
    expect(skip).toHaveTextContent("Clepsydra");
    expect(skip).toHaveTextContent("Opening the vault…");
    expect(skip).toHaveTextContent("Click or press Esc to skip");
    expect(skip).not.toHaveTextContent(/VESSEL|BIOS|operator/i);
  });

  it("shows keyboard focus on the skip button inside the viewport", () => {
    render(<BootSequence />);
    expect(
      screen.getByRole("button", { name: "Skip boot sequence" }),
    ).toHaveClass(
      "focus-visible:ring-2",
      "focus-visible:ring-inset",
      "focus-visible:ring-accent",
    );
  });

  it("renders nothing when not booting", () => {
    useUiStore.setState({ isBooting: false });
    const { container } = render(<BootSequence />);
    expect(container).toBeEmptyDOMElement();
  });

  it("ends on click", () => {
    render(<BootSequence />);
    fireEvent.click(screen.getByRole("button", { name: "Skip boot sequence" }));
    expect(useUiStore.getState().isBooting).toBe(false);
  });

  it("ends on Escape", () => {
    render(<BootSequence />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUiStore.getState().isBooting).toBe(false);
  });

  it("ends by itself after the boot hold", () => {
    render(<BootSequence />);
    act(() => {
      vi.advanceTimersByTime(2099);
    });
    expect(useUiStore.getState().isBooting).toBe(true);
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(useUiStore.getState().isBooting).toBe(false);
  });
});

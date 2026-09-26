import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SaveIndicator } from "#/editor/SaveIndicator";

const dot = (container: HTMLElement) =>
  container.querySelector("[data-dot]") as HTMLElement;

describe("SaveIndicator", () => {
  it.each([
    ["saved", "Saved", "bg-accent"],
    ["saving", "Saving…", "animate-pulse"],
    ["unsaved", "Unsaved changes", "bg-faint"],
  ] as const)("shows %s as a dot and a word", (status, word, cls) => {
    const { container } = render(<SaveIndicator status={status} />);
    expect(screen.getByText(word)).toBeVisible();
    expect(dot(container)).toHaveClass(cls);
  });

  it("shows a failed save in the warning tone", () => {
    render(<SaveIndicator status="error" error="boom" />);
    expect(screen.getByText("Save failed")).toHaveClass("text-hot");
  });

  it("uses no Vessel colour roles", () => {
    const { container } = render(<SaveIndicator status="error" />);
    expect(container.innerHTML).not.toMatch(
      /text-muted-foreground|text-destructive|text-foreground/,
    );
  });
});

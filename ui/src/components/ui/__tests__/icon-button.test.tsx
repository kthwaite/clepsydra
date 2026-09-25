import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IconButton } from "#/components/ui/icon-button";

describe("IconButton", () => {
  it("renders with aria-label", () => {
    render(
      <IconButton aria-label="Close">
        <svg data-testid="icon" />
      </IconButton>,
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });

  it("constrains child svg to h-4 w-4", () => {
    render(
      <IconButton aria-label="Close">
        <svg data-testid="icon" />
      </IconButton>,
    );
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("[&_svg]:h-4");
  });

  it("is a 32px round ghost button with the focus ring", () => {
    render(
      <IconButton aria-label="Close">
        <svg />
      </IconButton>,
    );
    expect(screen.getByRole("button")).toHaveClass(
      "h-8",
      "w-8",
      "rounded-full",
      "text-mute",
      "data-[focus-visible]:ring-2",
    );
  });
});

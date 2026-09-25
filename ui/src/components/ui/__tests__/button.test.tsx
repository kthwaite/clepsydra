import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "#/components/ui/button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeDefined();
  });

  it("defaults to the quiet (secondary) look: sink fill, 14px radius", () => {
    render(<Button>Default</Button>);
    const btn = screen.getByRole("button");
    expect(btn).toHaveClass("bg-sink", "rounded-[14px]");
  });

  it("makes primary a cobalt pill with raise-coloured text", () => {
    render(<Button variant="primary">Go</Button>);
    expect(screen.getByRole("button")).toHaveClass(
      "bg-accent",
      "text-raise",
      "rounded-full",
    );
  });

  it("makes ghost text-only", () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole("button");
    // No resting fill; a hover tint (data-[hovered]:bg-sink) is fine.
    expect(btn.className).not.toMatch(/(^|\s)bg-(sink|accent|hot)\b/);
    expect(btn).toHaveClass("text-mute");
  });

  it("makes danger a hot pill", () => {
    render(<Button variant="danger">Delete</Button>);
    expect(screen.getByRole("button")).toHaveClass("bg-hot", "rounded-full");
  });

  it("sizes md at 44px, sm at 32px and icon as a 32px circle", () => {
    const { rerender } = render(<Button variant="primary">Md</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-11");
    rerender(<Button size="sm">Sm</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-8");
    rerender(<Button size="icon">X</Button>);
    expect(screen.getByRole("button")).toHaveClass(
      "h-8",
      "w-8",
      "rounded-full",
    );
  });

  it.each(["primary", "secondary", "ghost", "danger"] as const)(
    "%s is sentence case with the shared focus ring",
    (variant) => {
      render(<Button variant={variant}>Label</Button>);
      const btn = screen.getByRole("button");
      expect(btn.className).not.toMatch(/uppercase|tracking-/);
      expect(btn).toHaveClass("data-[focus-visible]:ring-2");
    },
  );

  it("dims a disabled button", () => {
    render(<Button isDisabled>Off</Button>);
    expect(screen.getByRole("button")).toHaveClass(
      "data-[disabled]:opacity-45",
    );
  });

  it("fires onPress", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<Button onPress={handler}>Press</Button>);
    await user.click(screen.getByRole("button"));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("does not fire onPress when disabled", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(
      <Button onPress={handler} isDisabled>
        Nope
      </Button>,
    );
    await user.click(screen.getByRole("button"));
    expect(handler).not.toHaveBeenCalled();
  });

  it("merges custom className", () => {
    render(<Button className="my-extra">Custom</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("my-extra");
  });

  it("supports type=submit", () => {
    render(<Button type="submit">Submit</Button>);
    expect(screen.getByRole("button").getAttribute("type")).toBe("submit");
  });

  it("keeps the 44px height for primary and danger only; quiet and ghost md are 36px", () => {
    const { rerender } = render(<Button variant="primary">P</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-11");
    rerender(<Button variant="danger">D</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-11");
    rerender(<Button variant="secondary">S</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-9");
    rerender(<Button variant="ghost">G</Button>);
    expect(screen.getByRole("button")).toHaveClass("h-9");
  });
});

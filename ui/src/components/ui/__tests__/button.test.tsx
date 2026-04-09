import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Button } from "#/components/ui/button";

describe("Button", () => {
  it("renders children", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeDefined();
  });

  it("applies secondary variant classes by default", () => {
    render(<Button>Default</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-background");
  });

  it("applies primary variant classes", () => {
    render(<Button variant="primary">Go</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("bg-primary");
  });

  it("applies ghost variant classes", () => {
    render(<Button variant="ghost">Ghost</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("border-transparent");
  });

  it("applies sm size classes", () => {
    render(<Button size="sm">Small</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("normal-case");
  });

  it("applies icon size classes", () => {
    render(<Button size="icon">X</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("h-7");
    expect(btn.className).toContain("w-7");
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
});

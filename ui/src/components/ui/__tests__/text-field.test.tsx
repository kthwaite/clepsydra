import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TextField } from "#/components/ui/text-field";

describe("TextField", () => {
  it("renders label and input", () => {
    render(<TextField label="Name" />);
    expect(screen.getByLabelText("Name")).toBeDefined();
  });

  it("renders description", () => {
    render(<TextField label="Path" description="Example: notes/hello.md" />);
    expect(screen.getByText("Example: notes/hello.md")).toBeDefined();
  });

  it("shows error message when invalid", () => {
    render(
      <TextField label="Path" isInvalid errorMessage="Path is required." />,
    );
    expect(screen.getByText("Path is required.")).toBeDefined();
  });

  it("fires onChange", async () => {
    const user = userEvent.setup();
    const handler = vi.fn();
    render(<TextField label="Name" onChange={handler} />);
    await user.type(screen.getByLabelText("Name"), "hello");
    expect(handler).toHaveBeenLastCalledWith("hello");
  });

  it("renders placeholder", () => {
    render(<TextField label="Path" placeholder="notes/new.md" />);
    expect(screen.getByPlaceholderText("notes/new.md")).toBeDefined();
  });

  it("supports disabled state", () => {
    render(<TextField label="Name" isDisabled />);
    expect(
      screen.getByLabelText("Name").getAttribute("disabled"),
    ).not.toBeNull();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TagInput } from "#/components/ui/tag-input";

describe("TagInput", () => {
  it("renders label and existing tags", () => {
    render(
      <TagInput label="Tags" values={["alpha", "beta"]} onChange={() => {}} />,
    );
    expect(screen.getByText("Tags:")).toBeDefined();
    expect(screen.getByText("alpha")).toBeDefined();
    expect(screen.getByText("beta")).toBeDefined();
  });

  it("renders placeholder when empty", () => {
    render(
      <TagInput
        label="Tags"
        values={[]}
        onChange={() => {}}
        placeholder="Add tag..."
      />,
    );
    expect(screen.getByPlaceholderText("Add tag...")).toBeDefined();
  });

  it("hides placeholder when values exist", () => {
    render(
      <TagInput
        label="Tags"
        values={["alpha"]}
        onChange={() => {}}
        placeholder="Add tag..."
      />,
    );
    expect(screen.queryByPlaceholderText("Add tag...")).toBeNull();
  });

  it("adds tag on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={["alpha"]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "beta{Enter}");
    expect(onChange).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("adds tag on comma", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "gamma,");
    expect(onChange).toHaveBeenCalledWith(["gamma"]);
  });

  it("trims whitespace when adding", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "  delta  {Enter}");
    expect(onChange).toHaveBeenCalledWith(["delta"]);
  });

  it("does not add duplicate tags", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={["alpha"]} onChange={onChange} />);
    const input = screen.getByRole("textbox");
    await user.type(input, "alpha{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not add empty tags", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    await user.click(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes last tag on Backspace when input is empty", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput label="Tags" values={["alpha", "beta"]} onChange={onChange} />,
    );
    const input = screen.getByRole("textbox");
    await user.click(input);
    await user.keyboard("{Backspace}");
    expect(onChange).toHaveBeenCalledWith(["alpha"]);
  });

  it("removes a specific tag via remove button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput label="Tags" values={["alpha", "beta"]} onChange={onChange} />,
    );
    const removeButtons = screen.getAllByRole("button");
    await user.click(removeButtons[0]);
    expect(onChange).toHaveBeenCalledWith(["beta"]);
  });

  it("adds tag on blur when input has value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <>
        <TagInput label="Tags" values={[]} onChange={onChange} />
        <button type="button">other</button>
      </>,
    );
    const input = screen.getByRole("textbox");
    await user.type(input, "epsilon");
    await user.click(screen.getByText("other"));
    expect(onChange).toHaveBeenCalledWith(["epsilon"]);
  });

  it("has accessible tag group", () => {
    render(<TagInput label="Tags" values={["alpha"]} onChange={() => {}} />);
    expect(screen.getByRole("grid")).toBeDefined();
  });
});

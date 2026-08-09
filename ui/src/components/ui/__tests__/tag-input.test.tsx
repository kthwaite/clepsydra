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

  it("renders read-only values without remove controls", () => {
    render(
      <TagInput
        label="Tags"
        values={["pkm"]}
        readOnlyValues={["journal"]}
        onChange={() => {}}
      />,
    );

    expect(screen.getByText("journal")).toBeInTheDocument();
    expect(screen.getByText("pkm")).toBeInTheDocument();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button").parentElement).toHaveTextContent("pkm");
  });

  it("hides the placeholder when only read-only values exist", () => {
    render(
      <TagInput
        label="Tags"
        values={[]}
        readOnlyValues={["journal"]}
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
    const input = screen.getByRole("combobox");
    await user.type(input, "beta{Enter}");
    expect(onChange).toHaveBeenCalledWith(["alpha", "beta"]);
  });

  it("adds tag on comma", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "gamma,");
    expect(onChange).toHaveBeenCalledWith(["gamma"]);
  });

  it("trims whitespace when adding", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "  delta  {Enter}");
    expect(onChange).toHaveBeenCalledWith(["delta"]);
  });

  it("does not add duplicate tags", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={["alpha"]} onChange={onChange} />);
    const input = screen.getByRole("combobox");
    await user.type(input, "alpha{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not add a read-only value to editable values", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={["pkm"]}
        readOnlyValues={["journal"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox"), "journal{Enter}");

    expect(onChange).not.toHaveBeenCalled();
  });

  it("emits only editable values when adding a tag", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={["pkm"]}
        readOnlyValues={["journal"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox"), "daily{Enter}");

    expect(onChange).toHaveBeenCalledWith(["pkm", "daily"]);
    expect(onChange).not.toHaveBeenCalledWith(
      expect.arrayContaining(["journal"]),
    );
  });

  it("preserves an ordinary value that matches another caller's derived tag", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput label="Tags" values={["journal"]} onChange={onChange} />,
    );

    await user.type(screen.getByRole("combobox"), "daily{Enter}");

    expect(onChange).toHaveBeenCalledWith(["journal", "daily"]);
  });

  it("does not add empty tags", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<TagInput label="Tags" values={[]} onChange={onChange} />);
    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{Enter}");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes last tag on Backspace when input is empty", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput label="Tags" values={["alpha", "beta"]} onChange={onChange} />,
    );
    const input = screen.getByRole("combobox");
    await user.click(input);
    await user.keyboard("{Backspace}");
    expect(onChange).toHaveBeenCalledWith(["alpha"]);
  });

  it("Backspace removes only the last editable value", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={["pkm"]}
        readOnlyValues={["journal"]}
        onChange={onChange}
      />,
    );

    await user.click(screen.getByRole("combobox"));
    await user.keyboard("{Backspace}");

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith([]);
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
    const input = screen.getByRole("combobox");
    await user.type(input, "epsilon");
    await user.click(screen.getByText("other"));
    expect(onChange).toHaveBeenCalledWith(["epsilon"]);
  });

  it("has accessible tag group", () => {
    render(<TagInput label="Tags" values={["alpha"]} onChange={() => {}} />);
    expect(screen.getByRole("grid")).toBeDefined();
  });

  it("matches case-insensitively and excludes attached and derived tags", async () => {
    const user = userEvent.setup();
    render(
      <TagInput
        label="Tags"
        values={["rust"]}
        readOnlyValues={["brunch"]}
        suggestions={["rust", "brunch", "RUMination", "slate"]}
        onChange={() => {}}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "rU");

    expect(
      screen.getByRole("option", { name: "RUMination" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "rust" })).toBeNull();
    expect(screen.queryByRole("option", { name: "brunch" })).toBeNull();
    expect(screen.queryByRole("option", { name: "slate" })).toBeNull();
  });

  it("does not show suggestions for empty input", () => {
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust"]}
        onChange={() => {}}
      />,
    );

    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
  });

  it("does not show suggestions when suggestions are omitted", async () => {
    const user = userEvent.setup();
    render(<TagInput label="Tags" values={[]} onChange={() => {}} />);

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "ru");

    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
  });

  it("tab-completes the initially highlighted suggestion", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "ritual"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(2);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Tab}");

    expect(onChange).toHaveBeenLastCalledWith(["rust"]);
  });

  it("commits the arrow-highlighted suggestion on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react", "ritual"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenLastCalledWith(["react"]);
  });

  it("keeps the first suggestion highlighted on ArrowUp", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react", "ritual"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    await user.keyboard("{ArrowUp}{Enter}");

    expect(onChange).toHaveBeenLastCalledWith(["rust"]);
  });

  it("keeps the last suggestion highlighted on repeated ArrowDown", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react", "ritual"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");

    expect(onChange).toHaveBeenLastCalledWith(["ritual"]);
  });

  it("reopens dismissed suggestions on ArrowDown", async () => {
    const user = userEvent.setup();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust", "react"]}
        onChange={() => {}}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "r");
    await user.keyboard("{Escape}");
    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();

    await user.keyboard("{ArrowDown}");

    expect(
      screen.getByRole("listbox", { name: "Tag suggestions" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "react" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("dismisses suggestions with Escape without committing the draft", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <TagInput
        label="Tags"
        values={[]}
        suggestions={["rust"]}
        onChange={onChange}
      />,
    );

    await user.type(screen.getByRole("combobox", { name: "Add tags" }), "ru");
    await user.keyboard("{Escape}");

    expect(
      screen.queryByRole("listbox", { name: "Tag suggestions" }),
    ).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});

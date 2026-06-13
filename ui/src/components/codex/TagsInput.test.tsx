import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { TagsInput } from "#/components/codex/TagsInput";

const SUGGESTIONS = ["rust", "react", "ritual", "slate"];

/** Stateful wrapper so commits update the chips like in the real form. */
function Harness({
  initial = [],
  onChange,
  onContainerKeyDown,
}: {
  initial?: string[];
  onChange?: (tags: string[]) => void;
  onContainerKeyDown?: () => void;
}) {
  const [tags, setTags] = useState<string[]>(initial);
  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape") onContainerKeyDown?.();
      }}
    >
      <TagsInput
        value={tags}
        onChange={(t) => {
          setTags(t);
          onChange?.(t);
        }}
        suggestions={SUGGESTIONS}
      />
    </div>
  );
}

describe("TagsInput", () => {
  it("renders existing tags as chips", () => {
    render(<Harness initial={["rust", "pkm"]} />);
    expect(screen.getByText("#rust")).toBeInTheDocument();
    expect(screen.getByText("#pkm")).toBeInTheDocument();
  });

  it("commits a typed tag on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(screen.getByRole("combobox", { name: "Tags" }), "pkm");
    await user.keyboard("{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["pkm"]);
  });

  it("shows filtered suggestions and tab-completes the highlighted one", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(screen.getByRole("combobox", { name: "Tags" }), "ru");
    expect(screen.getByRole("option", { name: "#rust" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "#slate" })).toBeNull();
    await user.keyboard("{Tab}");
    expect(onChange).toHaveBeenLastCalledWith(["rust"]);
  });

  it("commits the arrow-highlighted suggestion on Enter", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.type(screen.getByRole("combobox", { name: "Tags" }), "r");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onChange).toHaveBeenLastCalledWith(["react"]);
  });

  it("does not offer already-selected tags", async () => {
    const user = userEvent.setup();
    render(<Harness initial={["rust"]} />);
    await user.type(screen.getByRole("combobox", { name: "Tags" }), "ru");
    expect(screen.queryByRole("option", { name: "#rust" })).toBeNull();
  });

  it("removes the last chip with Backspace on an empty draft", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={["rust", "pkm"]} onChange={onChange} />);
    await user.click(screen.getByRole("combobox", { name: "Tags" }));
    await user.keyboard("{Backspace}");
    expect(onChange).toHaveBeenLastCalledWith(["rust"]);
  });

  it("removes a chip via its × button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Harness initial={["rust", "pkm"]} onChange={onChange} />);
    await user.click(screen.getByRole("button", { name: "remove rust" }));
    expect(onChange).toHaveBeenLastCalledWith(["pkm"]);
  });

  it("swallows Escape while the suggestion list is open, bubbles it once closed", async () => {
    const user = userEvent.setup();
    const containerKey = vi.fn();
    render(<Harness onContainerKeyDown={containerKey} />);
    await user.type(screen.getByRole("combobox", { name: "Tags" }), "ru");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("option", { name: "#rust" })).toBeNull();
    expect(containerKey).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(containerKey).toHaveBeenCalledTimes(1);
  });
});

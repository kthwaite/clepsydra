import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalFeedGroups,
  FeedGroupComboBox,
} from "#/components/codex/FeedGroupComboBox";

const groups = ["Research", " research ", "RESEARCH", "Design"];

function renderCombo({
  value = "",
  disabled = false,
  onChange = vi.fn(),
}: {
  value?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
} = {}) {
  render(
    <div>
      <FeedGroupComboBox
        value={value}
        groups={groups}
        ariaLabel="Feed group"
        disabled={disabled}
        onChange={onChange}
      />
      <button type="button">Outside</button>
    </div>,
  );
  return {
    input: screen.getByRole("combobox", { name: "Feed group" }),
    onChange,
  };
}

describe("canonicalFeedGroups", () => {
  it("keeps the first trimmed manifest spelling and order for ASCII-case duplicates", () => {
    expect(canonicalFeedGroups(groups)).toEqual(["Research", "Design"]);
  });
});

describe("FeedGroupComboBox", () => {
  it("filters canonical suggestions case-insensitively", async () => {
    const user = userEvent.setup();
    const { input } = renderCombo();

    await user.type(input, "SEA");

    expect(
      await screen.findByRole("option", { name: "Research" }),
    ).toBeVisible();
    expect(screen.getAllByRole("option", { name: "Research" })).toHaveLength(1);
    expect(screen.queryByRole("option", { name: "Design" })).toBeNull();
  });

  it("commits a pointer selection with canonical spelling exactly once", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { input } = renderCombo({ onChange });

    await user.type(input, "research");
    await user.click(await screen.findByRole("option", { name: "Research" }));
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(input).toHaveValue("Research");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Research");
  });

  it("commits an Arrow/Enter selection with canonical spelling exactly once", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { input } = renderCombo({ onChange });

    await user.type(input, "res");
    await screen.findByRole("option", { name: "Research" });
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(input).toHaveValue("Research");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Research");
  });

  it("commits a novel Enter value exactly once", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { input } = renderCombo({ onChange });

    await user.type(input, "  New Group  {Enter}");
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(input).toHaveValue("New Group");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("New Group");
  });

  it("commits a novel draft on blur once", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { input } = renderCombo({ onChange });

    await user.type(input, "New Group");
    await user.click(screen.getByRole("button", { name: "Outside" }));
    await user.click(input);
    await user.click(screen.getByRole("button", { name: "Outside" }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("New Group");
  });

  it("closes suggestions on Escape without clearing the draft", async () => {
    const user = userEvent.setup();
    const { input, onChange } = renderCombo();

    await user.type(input, "res");
    expect(await screen.findByRole("listbox")).toBeVisible();
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(input).toHaveValue("res");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("prevents input and commits while disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { input } = renderCombo({ value: "Research", disabled: true, onChange });

    expect(input).toBeDisabled();
    await user.click(input);
    await user.keyboard("{Control>}a{/Control}New Group{Enter}");
    input.blur();

    expect(input).toHaveValue("Research");
    expect(onChange).not.toHaveBeenCalled();
  });
});

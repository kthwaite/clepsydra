import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectCombo } from "#/components/codex/ProjectCombo";

const options = ["atlas", "clepsydra", "vessel"];

function renderCombo({
  value = null,
  onAssign = vi.fn(),
  onClear = vi.fn(),
}: {
  value?: string | null;
  onAssign?: (slug: string) => void;
  onClear?: () => void;
} = {}) {
  const control = (nextValue: string | null) => (
    <div>
      <ProjectCombo
        value={nextValue}
        options={options}
        onAssign={onAssign}
        onClear={onClear}
      />
      <button type="button">Outside</button>
    </div>
  );
  const view = render(control(value));
  return {
    outside: screen.getByRole("button", { name: "Outside" }),
    onAssign,
    onClear,
    rerenderValue: (nextValue: string | null) =>
      view.rerender(control(nextValue)),
  };
}

// Queried afresh each time: Enter on a bare draft remounts the field.
const combobox = () => screen.getByRole("combobox", { name: "Project" });
// Waits out the open popover, which aria-hides the rest of the document.
const hint = () => screen.findByRole("status");

describe("ProjectCombo", () => {
  it("filters the listed projects by contains, ignoring case", async () => {
    const user = userEvent.setup();
    renderCombo();

    await user.type(combobox(), "TL");

    expect(await screen.findByRole("option", { name: "atlas" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "clepsydra" })).toBeNull();
    expect(screen.queryByRole("option", { name: "vessel" })).toBeNull();
  });

  it("never offers the draft itself as an option", async () => {
    const user = userEvent.setup();
    renderCombo();

    await user.type(combobox(), "ghost");

    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(screen.queryByRole("option")).toBeNull();
  });

  it("commits a pointer pick exactly once", async () => {
    const user = userEvent.setup();
    const { outside, onAssign } = renderCombo();

    await user.type(combobox(), "at");
    await user.click(await screen.findByRole("option", { name: "atlas" }));
    await user.click(outside);

    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith("atlas");
    expect(combobox()).toHaveValue("atlas");
    expect(await hint()).toHaveTextContent("");
  });

  it("commits an Arrow/Enter pick exactly once", async () => {
    const user = userEvent.setup();
    const { outside, onAssign } = renderCombo();

    await user.type(combobox(), "cl");
    await screen.findByRole("option", { name: "clepsydra" });
    await user.keyboard("{ArrowDown}{Enter}");
    await user.click(outside);

    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith("clepsydra");
    expect(combobox()).toHaveValue("clepsydra");
  });

  it("commits the listed slug on Enter when the draft equals it, ignoring case and padding", async () => {
    const user = userEvent.setup();
    const { onAssign } = renderCombo();

    await user.type(combobox(), "  ATLAS {Enter}");

    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith("atlas");
    expect(combobox()).toHaveValue("atlas");
    expect(combobox()).toHaveFocus();
    expect(await hint()).toHaveTextContent("");
  });

  it("keeps a draft no project matches on Enter and says so", async () => {
    const user = userEvent.setup();
    const { onAssign } = renderCombo();

    await user.type(combobox(), "atl{Enter}");

    expect(onAssign).not.toHaveBeenCalled();
    expect(combobox()).toHaveValue("atl");
    expect(combobox()).toHaveFocus();
    expect(await hint()).toHaveTextContent("no such project");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("reverts an unmatched draft to the current value on blur and clears the hint", async () => {
    const user = userEvent.setup();
    const { outside, onAssign } = renderCombo({ value: "vessel" });

    await user.clear(combobox());
    await user.type(combobox(), "ghost{Enter}");
    expect(await hint()).toHaveTextContent("no such project");

    await user.click(outside);

    expect(combobox()).toHaveValue("vessel");
    expect(await hint()).toHaveTextContent("");
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("reverts an unmatched draft to empty on blur when nothing is assigned", async () => {
    const user = userEvent.setup();
    const { outside, onAssign } = renderCombo();

    await user.type(combobox(), "ghost");
    await user.click(outside);

    expect(combobox()).toHaveValue("");
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("commits a draft that equals a listed slug on blur, once", async () => {
    const user = userEvent.setup();
    const { outside, onAssign, rerenderValue } = renderCombo();

    await user.type(combobox(), "vessel");
    await user.click(outside);
    rerenderValue("vessel");
    await user.click(combobox());
    await user.click(outside);

    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign).toHaveBeenCalledWith("vessel");
    expect(combobox()).toHaveValue("vessel");
  });

  it("does not re-assign the value already held", async () => {
    const user = userEvent.setup();
    const { outside, onAssign } = renderCombo({ value: "atlas" });

    await user.click(combobox());
    await user.keyboard("{Enter}");
    await user.clear(combobox());
    await user.type(combobox(), "Atlas{Enter}");
    await user.click(outside);

    expect(onAssign).not.toHaveBeenCalled();
    expect(combobox()).toHaveValue("atlas");
    expect(await hint()).toHaveTextContent("");
  });

  it("does not re-fire a pointer pick on the blur that follows it", async () => {
    // The caller may leave `value` unchanged (bulk apply); the pick must still
    // reach onAssign exactly once, not again when focus leaves.
    const user = userEvent.setup();
    const { outside, onAssign } = renderCombo();

    await user.type(combobox(), "ves");
    await user.click(await screen.findByRole("option", { name: "vessel" }));
    await user.click(outside);
    await user.click(combobox());
    await user.click(outside);

    expect(onAssign).toHaveBeenCalledTimes(1);
  });

  it("follows an externally changed value", async () => {
    const user = userEvent.setup();
    const { outside, onAssign, rerenderValue } = renderCombo({
      value: "atlas",
    });

    rerenderValue("clepsydra");
    expect(combobox()).toHaveValue("clepsydra");

    await user.click(combobox());
    await user.click(outside);
    expect(combobox()).toHaveValue("clepsydra");
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("clears through the × button", async () => {
    const user = userEvent.setup();
    const { onClear } = renderCombo({ value: "atlas" });

    await user.click(screen.getByRole("button", { name: "Clear project" }));

    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("offers no × button while nothing is assigned", () => {
    renderCombo();
    expect(screen.queryByRole("button", { name: "Clear project" })).toBeNull();
  });

  it("labels the × button after a custom aria label", () => {
    render(
      <ProjectCombo
        value="atlas"
        options={options}
        ariaLabel="Draft project"
        onAssign={vi.fn()}
        onClear={vi.fn()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Clear Draft project" }),
    ).toBeInTheDocument();
  });
});

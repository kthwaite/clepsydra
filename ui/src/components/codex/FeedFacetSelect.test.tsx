import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FeedFacetSelect } from "#/components/codex/FeedFacetSelect";

const groups = [
  { value: "Engineering", label: "Engineering" },
  { value: "Ops", label: "Ops" },
  { value: "Reading", label: "Reading" },
];

function openList(label: string) {
  return userEvent
    .setup()
    .click(
      screen.getByRole("button", { name: new RegExp(`${label} filter`, "i") }),
    );
}

describe("FeedFacetSelect", () => {
  it("summarizes an empty selection as all", () => {
    render(
      <FeedFacetSelect
        label="Group"
        options={groups}
        value={[]}
        onChange={vi.fn()}
        multiple
      />,
    );

    const trigger = screen.getByRole("button", { name: /group filter/i });
    expect(trigger).toHaveTextContent(/all/i);
  });

  it("names a single selection and counts several", () => {
    const view = render(
      <FeedFacetSelect
        label="Group"
        options={groups}
        value={["Ops"]}
        onChange={vi.fn()}
        multiple
      />,
    );
    expect(
      screen.getByRole("button", { name: /group filter/i }),
    ).toHaveTextContent("Ops");

    view.rerender(
      <FeedFacetSelect
        label="Group"
        options={groups}
        value={["Ops", "Reading"]}
        onChange={vi.fn()}
        multiple
      />,
    );
    expect(
      screen.getByRole("button", { name: /group filter/i }),
    ).toHaveTextContent(/2 selected/i);
  });

  it("adds to a multi-select without dropping the existing values", async () => {
    const onChange = vi.fn();
    render(
      <FeedFacetSelect
        label="Group"
        options={groups}
        value={["Engineering"]}
        onChange={onChange}
        multiple
      />,
    );

    await openList("Group");
    await userEvent.setup().click(screen.getByRole("button", { name: "Ops" }));

    expect(onChange).toHaveBeenCalledWith(["Engineering", "Ops"]);
  });

  it("removes an already selected multi-select value", async () => {
    const onChange = vi.fn();
    render(
      <FeedFacetSelect
        label="Group"
        options={groups}
        value={["Engineering", "Ops"]}
        onChange={onChange}
        multiple
      />,
    );

    await openList("Group");
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Engineering" }));

    expect(onChange).toHaveBeenCalledWith(["Ops"]);
  });

  it("replaces the value of a single select and clears it when toggled off", async () => {
    const onChange = vi.fn();
    const view = render(
      <FeedFacetSelect
        label="Tag"
        options={groups}
        value={["Engineering"]}
        onChange={onChange}
      />,
    );

    await openList("Tag");
    await userEvent.setup().click(screen.getByRole("button", { name: "Ops" }));
    expect(onChange).toHaveBeenCalledWith(["Ops"]);

    onChange.mockClear();
    view.rerender(
      <FeedFacetSelect
        label="Tag"
        options={groups}
        value={["Ops"]}
        onChange={onChange}
      />,
    );
    await openList("Tag");
    await userEvent.setup().click(screen.getByRole("button", { name: "Ops" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("marks the selected options as pressed", async () => {
    render(
      <FeedFacetSelect
        label="Group"
        options={groups}
        value={["Ops"]}
        onChange={vi.fn()}
        multiple
      />,
    );

    await openList("Group");

    expect(screen.getByRole("button", { name: "Ops" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "Reading" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("disables the trigger when no options exist", () => {
    render(
      <FeedFacetSelect
        label="Feed"
        options={[]}
        value={[]}
        onChange={vi.fn()}
        multiple
      />,
    );

    expect(screen.getByRole("button", { name: /feed filter/i })).toBeDisabled();
  });
});

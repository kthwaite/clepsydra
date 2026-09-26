import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  FilterPicker,
  GroupPicker,
  type PickerColumn,
  SortPicker,
} from "#/components/bases/BasePickers";

const columns: PickerColumn[] = [
  {
    column: "title",
    label: "Title",
    allowsSorting: true,
    groupable: false,
    presets: [],
    optionOverflow: 0,
  },
  {
    column: "status",
    label: "Status",
    allowsSorting: true,
    groupable: true,
    presets: [
      {
        field: "status",
        op: "eq",
        value: "reading",
        label: "Status is reading",
      },
      { field: "status", op: "is_empty", label: "Status is empty" },
    ],
    optionOverflow: 2,
  },
  {
    column: "body",
    label: "Body",
    allowsSorting: false,
    groupable: false,
    presets: [],
    optionOverflow: 0,
  },
];

describe("FilterPicker", () => {
  it("counts active filters and adds a column's preset", async () => {
    const user = userEvent.setup();
    const onAddQuickFilter = vi.fn();
    render(
      <FilterPicker
        columns={columns}
        activeCount={1}
        onAddQuickFilter={onAddQuickFilter}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Filter · 1" }));
    expect(screen.queryByRole("menuitem", { name: "Title" })).toBeNull();
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Status is reading" }),
    );
    expect(onAddQuickFilter).toHaveBeenCalledWith({
      field: "status",
      op: "eq",
      value: "reading",
      label: "Status is reading",
    });
  });

  it("says how many options it left out", async () => {
    const user = userEvent.setup();
    render(
      <FilterPicker
        columns={columns}
        activeCount={0}
        onAddQuickFilter={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Filter" }));
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    expect(
      await screen.findByRole("menuitem", {
        name: "… and 2 more — use a cell",
      }),
    ).toHaveAttribute("aria-disabled", "true");
  });
});

describe("SortPicker", () => {
  it("names the effective sort and sets a column and direction", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <SortPicker
        columns={columns}
        sort={{ field: "title", dir: "asc" }}
        overridden={false}
        onSortChange={onSortChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Sort · Title ↑" }));
    expect(screen.queryByRole("menuitem", { name: "Body" })).toBeNull();
    expect(
      screen.queryByRole("menuitem", { name: "Use the view's sort" }),
    ).toBeNull();
    await user.click(await screen.findByRole("menuitem", { name: "Status" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Descending" }),
    );
    expect(onSortChange).toHaveBeenCalledWith([
      { field: "status", dir: "desc" },
    ]);
  });

  it("offers the view's sort back only when overridden", async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <SortPicker
        columns={columns}
        sort={{ field: "status", dir: "desc" }}
        overridden
        onSortChange={onSortChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Sort · Status ↓" }));
    await user.click(
      await screen.findByRole("menuitem", { name: "Use the view's sort" }),
    );
    expect(onSortChange).toHaveBeenCalledWith(undefined);
  });
});

describe("GroupPicker", () => {
  it("names the effective grouping and ungroups", async () => {
    const user = userEvent.setup();
    const onSetGroup = vi.fn();
    render(
      <GroupPicker
        columns={columns}
        group="status"
        overridden={false}
        onSetGroup={onSetGroup}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Group · Status" }));
    expect(screen.queryByRole("menuitemradio", { name: "Title" })).toBeNull();
    expect(
      screen.getByRole("menuitemradio", { name: "Status" }),
    ).toHaveAttribute("aria-checked", "true");
    await user.click(
      screen.getByRole("menuitemradio", { name: "No grouping" }),
    );
    expect(onSetGroup).toHaveBeenCalledWith({ kind: "flat" });
  });

  it("groups by a column and offers the view's grouping back when overridden", async () => {
    const user = userEvent.setup();
    const onSetGroup = vi.fn();
    render(
      <GroupPicker
        columns={columns}
        group={undefined}
        overridden
        onSetGroup={onSetGroup}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Group" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Status" }));
    expect(onSetGroup).toHaveBeenCalledWith({ kind: "by", field: "status" });
    await user.click(screen.getByRole("button", { name: "Group" }));
    await user.click(
      await screen.findByRole("menuitemradio", {
        name: "Use the view's grouping",
      }),
    );
    expect(onSetGroup).toHaveBeenLastCalledWith(undefined);
  });
});

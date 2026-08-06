import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BaseDetailResponse, QueryOutput } from "#/api/bases";
import { BaseTableView } from "#/components/bases/BaseTableView";

const definition: BaseDetailResponse = {
  slug: "reading",
  name: "Reading Log",
  properties: {
    author: { type: "text" },
    rating: { type: "number" },
    status: { type: "select", options: ["queued", "reading"] },
  },
  views: [
    { name: "Continues", layout: "table", columns: ["title", "author"] },
    {
      name: "Shelf",
      layout: "table",
      group_by: "status",
      aggregates: [{ fn: "count" }, { fn: "avg", field: "rating" }],
      columns: ["title", "rating"],
    },
  ],
  diagnostics: [],
};

const row = {
  id: "01",
  path: "book.md",
  title: "The Book of the New Sun",
  kind: "BOOK",
  columns: { author: "Gene Wolfe", rating: 4.5, status: "reading" },
};

const flat: QueryOutput = { shape: "flat", rows: [row], total: 1 };

function renderView(overrides: Partial<Parameters<typeof BaseTableView>[0]>) {
  const spies = {
    onViewChange: vi.fn(),
    onSortChange: vi.fn(),
    onOpenPage: vi.fn(),
    onCommitCell: vi.fn(),
  };
  render(
    <BaseTableView
      definition={definition}
      activeView="Continues"
      output={flat}
      sortOverride={{}}
      {...spies}
      {...overrides}
    />,
  );
  return spies;
}

describe("BaseTableView", () => {
  it("renders every view name in the switcher and switches on click", async () => {
    const user = userEvent.setup();
    const props = renderView({});
    expect(screen.getByRole("button", { name: "Continues" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Shelf" }));
    expect(props.onViewChange).toHaveBeenCalledWith("Shelf");
  });

  it("renders group header rows with aggregate chips", () => {
    const grouped: QueryOutput = {
      shape: "grouped",
      groups: [
        { key: "reading", total: 2, aggregates: [2, 4.75], rows: [row] },
        { key: null, total: 1, aggregates: [1, null], rows: [] },
      ],
    };
    renderView({ activeView: "Shelf", output: grouped });
    expect(screen.getByText("reading")).toBeTruthy();
    expect(screen.getByText("2 rows")).toBeTruthy();
    expect(screen.getByText(/count\s*2/)).toBeTruthy();
    expect(screen.getByText(/avg\(rating\)\s*4.75/)).toBeTruthy();
    // The NULL bucket renders as the labelled empty group.
    expect(screen.getByText("(empty)")).toBeTruthy();
  });

  it("title cell navigates to the page", async () => {
    const user = userEvent.setup();
    const props = renderView({});
    await user.click(
      screen.getByRole("button", { name: "The Book of the New Sun" }),
    );
    expect(props.onOpenPage).toHaveBeenCalledWith("book.md");
  });

  it("commits an edited property cell with only the changed key", async () => {
    const user = userEvent.setup();
    const props = renderView({});
    await user.click(screen.getByRole("button", { name: "Gene Wolfe" }));
    const input = screen.getByRole("textbox", { name: "Edit text" });
    await user.clear(input);
    await user.type(input, "G-Wolfe{Enter}");
    expect(props.onCommitCell).toHaveBeenCalledTimes(1);
    const [commitRow, key, value] = props.onCommitCell.mock.calls[0];
    expect(commitRow.id).toBe("01");
    expect(key).toBe("author");
    expect(value).toBe("G-Wolfe");
  });
});

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { BaseTableView } from "#/components/bases/BaseTableView";
import type { BaseTableViewReady } from "#/components/bases/base-table-model";

vi.mock("#/components/bases/BaseCsvActions", () => ({
  BaseCsvActions: () => null,
}));
const rows = ["one", "two", "three"].map((id) => ({
  id,
  path: `${id}.md`,
  title: id,
  kind: "NOTE",
  columns: { score: 0.25 },
}));
function model(): BaseTableViewReady {
  return {
    status: "ready",
    definition: {
      slug: "test",
      revision: "r1",
      name: "Test",
      diagnostics: [],
      member_creation: [],
      properties: [
        {
          key: "score",
          definition: {
            type: "number",
            format: "percent",
            description: "Fraction completed",
          },
        },
      ],
      views: [
        {
          name: "All",
          layout: "table",
          columns: ["title", "score"],
          aggregates: [
            { fn: "avg", field: "score" },
            { fn: "count_filled", field: "score" },
          ],
        },
      ],
    },
    query: {
      activeView: "All",
      output: { shape: "flat", rows, total: 3, aggregates: [0.25, 3] },
      loading: false,
      error: undefined,
      sort: undefined,
      onViewChange: vi.fn(),
      onSortChange: vi.fn(),
    },
    rowActions: { onOpenPage: vi.fn(), onCommitCell: vi.fn() },
    bulk: {
      run: vi.fn().mockResolvedValue({
        succeeded: ["one"],
        failures: [
          { id: "two", label: "two", message: "Conflict (409)" },
          { id: "three", label: "three", message: "Protected page" },
        ],
      }),
    },
  };
}
it("selects only loaded rows with pointer ranges and guarded keyboard ranges", async () => {
  const user = userEvent.setup();
  const value = model();
  render(<BaseTableView model={value} />);
  await user.click(screen.getByRole("checkbox", { name: "Select one" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Select three" }), {
    shiftKey: true,
  });
  expect(screen.getByText("3 selected (loaded rows only)")).toBeInTheDocument();
  screen.getByRole("button", { name: "two" }).focus();
  await user.keyboard("{Escape} ");
  expect(screen.getByRole("checkbox", { name: "Select two" })).toBeChecked();
  expect(
    screen.getByRole("checkbox", { name: "Select one" }),
  ).not.toBeChecked();
  screen.getByRole("button", { name: "three" }).focus();
  await user.keyboard("{Shift>} {/Shift}");
  expect(screen.getByText("2 selected (loaded rows only)")).toBeInTheDocument();
});
it.each(["full", "compact"] as const)(
  "confirms archive and retains failed rows with individual messages in %s mode",
  async (chrome) => {
    const user = userEvent.setup();
    const value = model();
    render(<BaseTableView model={value} chrome={chrome} />);
    await user.click(
      screen.getByRole("checkbox", { name: "Select all loaded rows" }),
    );
    await user.click(screen.getByRole("button", { name: "Archive selected…" }));
    expect(value.bulk?.run).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Confirm archive" }));
    await waitFor(() =>
      expect(value.bulk?.run).toHaveBeenCalledWith(rows, { kind: "archive" }),
    );
    expect(screen.getByText("two: Conflict (409)")).toBeInTheDocument();
    expect(screen.getByText("three: Protected page")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select one" }),
    ).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Select two" })).toBeChecked();
  },
);
it("formats value aggregates but not count aggregates and describes headers", () => {
  render(<BaseTableView model={model()} />);
  expect(screen.getByText("avg(score) 25%")).toBeInTheDocument();
  expect(screen.getByText("count_filled(score) 3")).toBeInTheDocument();
  expect(screen.getByTitle("Fraction completed")).toBeInTheDocument();
});

it.each(["percent", "currency"] as const)(
  "keeps percent_filled percentages independent of the property's %s format",
  (format) => {
    const value = model();
    value.definition.properties = [
      {
        key: "score",
        definition: {
          type: "number",
          format,
          currency: format === "currency" ? "USD" : undefined,
        },
      },
    ];
    value.definition.views = [
      {
        name: "All",
        columns: ["title", "score"],
        aggregates: [{ fn: "percent_filled", field: "score" }],
      },
    ];
    value.query.output = { shape: "flat", rows, total: 3, aggregates: [50] };
    render(<BaseTableView model={value} />);
    expect(screen.getByText("percent_filled(score) 50%")).toBeInTheDocument();
  },
);
it.each(["full", "compact"] as const)(
  "announces search totals and no matches in %s tables",
  async (chrome) => {
    const user = userEvent.setup();
    const value = model();
    value.query.search = "missing";
    value.query.searchApplied = "missing";
    value.query.onSearchChange = vi.fn();
    value.query.output = {
      shape: "flat",
      rows: [],
      total: 0,
      unfiltered_total: 12,
      aggregates: [],
    };
    render(<BaseTableView model={value} chrome={chrome} />);
    expect(screen.getByText("0 of 12 rows")).toBeInTheDocument();
    expect(screen.getByText("No rows match your search.")).toBeInTheDocument();
    await user.click(screen.getByRole("searchbox", { name: "Search rows" }));
    await user.keyboard("{Escape}");
    expect(value.query.onSearchChange).toHaveBeenCalledWith("");
  },
);

it("does not clear selection when Escape closes an inline editor, and resets on a new query", async () => {
  const user = userEvent.setup();
  const value = model();
  value.query.identity = "first";
  const view = render(<BaseTableView model={value} />);
  await user.click(screen.getByRole("checkbox", { name: "Select one" }));
  await user.click(screen.getAllByRole("button", { name: "25%" })[0]);
  await user.keyboard("{Escape}");
  expect(screen.getByRole("checkbox", { name: "Select one" })).toBeChecked();
  view.rerender(
    <BaseTableView
      model={{ ...value, query: { ...value.query, identity: "second" } }}
    />,
  );
  expect(
    screen.getByRole("checkbox", { name: "Select one" }),
  ).not.toBeChecked();
  view.rerender(<BaseTableView model={value} />);
  expect(
    screen.getByRole("checkbox", { name: "Select one" }),
  ).not.toBeChecked();
});

it("limits select-all to loaded rows and preserves other groups when one group clears", async () => {
  const user = userEvent.setup();
  const value = model();
  value.query.output = {
    shape: "grouped",
    groups: [
      { key: "first", rows: rows.slice(0, 2), total: 200, aggregates: [] },
      { key: "second", rows: rows.slice(2), total: 200, aggregates: [] },
    ],
  };
  render(<BaseTableView model={value} />);
  const first = screen.getByRole("checkbox", {
    name: "Select all loaded rows in Test — first",
  });
  await user.click(first);
  await user.click(
    screen.getByRole("checkbox", {
      name: "Select all loaded rows in Test — second",
    }),
  );
  expect(screen.getByText("3 selected (loaded rows only)")).toBeInTheDocument();
  await user.click(first);
  expect(screen.getByText("1 selected (loaded rows only)")).toBeInTheDocument();
  expect(screen.getByRole("checkbox", { name: "Select three" })).toBeChecked();
});

it("offers scalar system grouping but rejects multi-valued system fields with qualified names", async () => {
  const user = userEvent.setup();
  const value = model();
  value.definition.views = [
    { name: "All", columns: ["title", "sys.word_count", "sys.tags"] },
  ];
  render(<BaseTableView model={value} />);
  await user.click(
    screen.getByRole("button", { name: "sys.word_count column menu" }),
  );
  expect(
    screen.getByRole("menuitem", { name: "Group by sys.word_count" }),
  ).not.toHaveAttribute("aria-disabled", "true");
  await user.keyboard("{Escape}");
  await user.click(
    screen.getByRole("button", { name: "sys.tags column menu" }),
  );
  expect(
    screen.getByRole("menuitem", { name: "Group by sys.tags" }),
  ).toHaveAttribute("aria-disabled", "true");
});

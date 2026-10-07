import type { Meta, StoryObj } from "@storybook/react-vite";
import type { BaseDetailResponse, QueryOutput } from "#/api/bases";
import { BaseTableView } from "./BaseTableView";
import type { BaseTableViewReady } from "./base-table-model";

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "storybook-revision",
  name: "Reading Log",
  description: "Books in flight and their wake.",
  properties: [
    { key: "author", definition: { type: "text" } },
    {
      key: "status",
      definition: {
        type: "select",
        options: ["queued", "reading", "finished", "abandoned"],
      },
    },
    { key: "rating", definition: { type: "number" } },
    { key: "started", definition: { type: "date" } },
  ],
  views: [
    {
      name: "Continues",
      layout: "table",
      columns: ["title", "author", "status", "rating"],
    },
    {
      name: "Shelf",
      layout: "table",
      group_by: "status",
      aggregates: [{ fn: "count" }, { fn: "avg", field: "rating" }],
      columns: ["title", "author", "rating"],
    },
  ],
  diagnostics: [],
  member_creation: [],
};

const rows = [
  {
    id: "01",
    path: "book-of-the-new-sun.md",
    title: "The Book of the New Sun",
    kind: "BOOK",
    columns: { author: "Gene Wolfe", status: "reading", rating: 4.5 },
  },
  {
    id: "02",
    path: "left-hand-of-darkness.md",
    title: "The Left Hand of Darkness",
    kind: "BOOK",
    columns: { author: "Ursula K. Le Guin", status: "reading", rating: 5 },
  },
  {
    id: "03",
    path: "ficciones.md",
    title: "Ficciones",
    kind: "BOOK",
    columns: { author: "Jorge Luis Borges", status: "queued", rating: null },
  },
];

const flat: QueryOutput = { shape: "flat", rows, total: 3, aggregates: [] };

const grouped: QueryOutput = {
  shape: "grouped",
  groups: [
    {
      key: "queued",
      total: 1,
      aggregates: [1, null],
      rows: rows.filter((r) => r.columns.status === "queued"),
    },
    {
      key: "reading",
      total: 2,
      aggregates: [2, 4.75],
      rows: rows.filter((r) => r.columns.status === "reading"),
    },
  ],
};

function model(activeView: string, output: QueryOutput): BaseTableViewReady {
  return {
    status: "ready",
    definition,
    query: {
      activeView,
      output,
      error: undefined,
      loading: false,
      sort: undefined,
      onViewChange: () => {},
      onSortChange: () => {},
    },
    rowActions: { onOpenPage: () => {}, onCommitCell: () => {} },
  };
}

const meta: Meta<typeof BaseTableView> = {
  title: "Bases/BaseTable",
  component: BaseTableView,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Flat: Story = {
  args: { model: model("Continues", flat) },
};

export const Grouped: Story = {
  args: { model: model("Shelf", grouped) },
};

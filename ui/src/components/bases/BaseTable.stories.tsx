import type { Meta, StoryObj } from "@storybook/react-vite";
import type { BaseDetailResponse, QueryOutput } from "#/api/bases";
import { BaseTableView } from "./BaseTableView";

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "storybook-revision",
  name: "Reading Log",
  description: "Books in flight and their wake.",
  properties: {
    author: { type: "text" },
    status: {
      type: "select",
      options: ["queued", "reading", "finished", "abandoned"],
    },
    rating: { type: "number" },
    started: { type: "date" },
  },
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

const flat: QueryOutput = { shape: "flat", rows, total: 3 };

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

const meta: Meta<typeof BaseTableView> = {
  title: "Bases/BaseTable",
  component: BaseTableView,
  args: {
    definition,
    sortOverride: {},
    onViewChange: () => {},
    onSortChange: () => {},
    onOpenPage: () => {},
    onCommitCell: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Flat: Story = {
  args: { activeView: "Continues", output: flat },
};

export const Grouped: Story = {
  args: { activeView: "Shelf", output: grouped },
};

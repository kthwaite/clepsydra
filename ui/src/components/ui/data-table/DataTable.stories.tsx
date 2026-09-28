import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import {
  type DataColumn,
  DataTable,
  type RowSelectionState,
  type SortDirection,
} from "#/components/ui/data-table";

interface Work {
  id: string;
  title: string;
  author: string;
  status: string;
  words: number;
  created: string;
}

const WORKS: Work[] = [
  {
    id: "w1",
    title: "The Shadow of the Torturer",
    author: "Gene Wolfe",
    status: "reading",
    words: 104000,
    created: "2026-08-02",
  },
  {
    id: "w2",
    title: "Piranesi",
    author: "Susanna Clarke",
    status: "done",
    words: 85000,
    created: "2026-07-14",
  },
  {
    id: "w3",
    title: "The Left Hand of Darkness",
    author: "Ursula K. Le Guin",
    status: "queued",
    words: 91000,
    created: "2026-06-30",
  },
  {
    id: "w4",
    title: "Solaris",
    author: "Stanisław Lem",
    status: "done",
    words: 72000,
    created: "2026-05-21",
  },
];

function useColumnState(initialOrder: string[]) {
  const [order, setOrder] = useState(initialOrder);
  const [widths, setWidths] = useState<Record<string, number>>({});
  return {
    columnOrder: order,
    onColumnOrderChange: (next: string[]) => setOrder(next),
    columnWidths: widths,
    onColumnWidthChange: (id: string, width: number | undefined) =>
      setWidths((current) => {
        const next = { ...current };
        if (width === undefined) delete next[id];
        else next[id] = width;
        return next;
      }),
  };
}

/** Bases-like: a pinned, filling title with a menu button in each header,
 *  click-to-sort headers, and a row action revealed on hover. */
function BasesLike() {
  const [sort, setSort] = useState<{
    column: string;
    direction: SortDirection;
  }>({ column: "title", direction: "ascending" });
  const columns: DataColumn<Work>[] = [
    {
      id: "title",
      label: "Title",
      fill: true,
      minWidth: 220,
      pinned: true,
      rowHeader: true,
      sortable: true,
      cell: (work) => (
        <span className="flex items-center gap-2">
          <button type="button" className="truncate text-left text-ink">
            {work.title}
          </button>
          <button
            type="button"
            aria-label={`Row actions for ${work.title}`}
            className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
          >
            ⋯
          </button>
        </span>
      ),
    },
    ...(["author", "status"] as const).map(
      (id): DataColumn<Work> => ({
        id,
        label: id === "author" ? "Author" : "Status",
        width: 180,
        sortable: true,
        header: ({ sorted }) => (
          <span className="flex items-center gap-1">
            {id === "author" ? "Author" : "Status"}
            {sorted && (
              <span aria-hidden>{sorted === "descending" ? "↓" : "↑"}</span>
            )}
            <button type="button" aria-label={`${id} column menu`}>
              ⋯
            </button>
          </span>
        ),
        cell: (work) => work[id],
      }),
    ),
  ];
  return (
    <DataTable<Work>
      ariaLabel="Reading list — Table"
      rows={WORKS}
      columns={columns}
      getRowId={(work) => work.id}
      density="compact"
      sort={sort}
      onHeaderSort={(column) =>
        setSort((current) => ({
          column,
          direction:
            current.column === column && current.direction === "ascending"
              ? "descending"
              : "ascending",
        }))
      }
      rowClassName={() => "h-8 hover:[&>td]:bg-sink"}
      {...useColumnState(["title", "author", "status"])}
    />
  );
}

/** Gazetteer-like: a checkbox column, a pinned "No.", a filling title that
 *  moves but does not resize, right-aligned numbers, and Enter/click to open. */
function GazetteerLike() {
  const [selected, setSelected] = useState<RowSelectionState>({});
  const [opened, setOpened] = useState("");
  const columns: DataColumn<Work>[] = [
    {
      id: "no",
      label: "No.",
      width: 52,
      pinned: true,
      cell: (_work, index) => String(index + 1).padStart(3, "0"),
    },
    {
      id: "title",
      label: "Title",
      fill: true,
      minWidth: 240,
      resizable: false,
      sortable: true,
      rowHeader: true,
      cell: (work) => <span className="truncate text-ink">{work.title}</span>,
    },
    {
      id: "words",
      label: "Words",
      width: 76,
      align: "end",
      sortable: true,
      cell: (work) => work.words.toLocaleString(),
    },
    {
      id: "created",
      label: "Created",
      width: 110,
      align: "end",
      sortable: true,
      cell: (work) => work.created,
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <DataTable<Work>
        ariaLabel="Gazetteer"
        rows={WORKS}
        columns={columns}
        getRowId={(work) => work.id}
        density="comfortable"
        sort={{ column: "created", direction: "descending" }}
        selection={{
          selected,
          onChange: setSelected,
          allLabel: "Select all visible rows",
          rowLabel: (work) => `Select ${work.title}`,
        }}
        onRowActivate={(work) => setOpened(work.title)}
        rowClassName={(_work, { selected: isSelected }) =>
          isSelected
            ? "h-[42px] [&>td]:bg-accent-tint"
            : "h-[42px] hover:[&>td]:bg-sink"
        }
        stickyHeader
        {...useColumnState(["no", "title", "words", "created"])}
      />
      <p className="text-[13px] text-mute">
        {opened ? `Opened ${opened}` : "Click a row or press Enter to open it."}
      </p>
    </div>
  );
}

const meta: Meta = {
  title: "UI/DataTable",
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Bases: Story = { render: () => <BasesLike /> };

export const Gazetteer: Story = { render: () => <GazetteerLike /> };

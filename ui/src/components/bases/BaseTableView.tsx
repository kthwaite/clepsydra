import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from "react-aria-components";
import type {
  BaseDetailResponse,
  GroupResult,
  PropertyType,
  QueryOutput,
  QueryRow,
  ViewOverrides,
} from "#/api/bases";
import { cn } from "#/lib/cn";
import { type CellValue, formatCellValue } from "./cells/types";
import { EditableCell } from "./EditableCell";

export interface BaseTableViewProps {
  definition: BaseDetailResponse;
  activeView: string;
  onViewChange: (name: string) => void;
  output: QueryOutput | undefined;
  sortOverride: ViewOverrides;
  onSortChange: (override: ViewOverrides) => void;
  onOpenPage: (path: string) => void;
  onCommitCell: (
    row: QueryRow,
    key: string,
    value: CellValue,
    hint?: PropertyType,
  ) => void;
}

/** System columns render read-only; everything else edits via the registry. */
const SYSTEM_COLUMNS = new Set([
  "title",
  "path",
  "created_at",
  "updated_at",
  "journal_date",
  "word_count",
]);

function aggregateLabel(
  definition: BaseDetailResponse,
  viewName: string,
  index: number,
): string {
  const view = definition.views?.find((v) => v.name === viewName);
  const agg = view?.aggregates?.[index];
  if (!agg) return "";
  return agg.field ? `${agg.fn}(${agg.field})` : agg.fn;
}

/**
 * The Vessel data grid: one react-aria `Table` per (group of) rows, column
 * sorting mapped to query sort overrides, group header rows carrying
 * aggregate chips. Purely presentational — data and commits flow through
 * props (`BaseTable` wires the queries).
 */
export function BaseTableView({
  definition,
  activeView,
  onViewChange,
  output,
  sortOverride,
  onSortChange,
  onOpenPage,
  onCommitCell,
}: BaseTableViewProps) {
  const view = definition.views?.find((v) => v.name === activeView);
  const columns =
    view?.columns && view.columns.length > 0 ? view.columns : ["title"];

  const sortDescriptor = sortOverride.sort
    ? {
        column: sortOverride.sort,
        direction:
          sortOverride.dir === "desc"
            ? ("descending" as const)
            : ("ascending" as const),
      }
    : undefined;

  const grid = (rows: QueryRow[], label: string) => (
    <Table
      aria-label={label}
      sortDescriptor={sortDescriptor}
      onSortChange={(descriptor) =>
        onSortChange({
          sort: String(descriptor.column),
          dir: descriptor.direction === "descending" ? "desc" : "asc",
        })
      }
      className="w-full border-collapse"
    >
      <TableHeader>
        {columns.map((column) => (
          <Column
            key={column}
            id={column}
            isRowHeader={column === columns[0]}
            allowsSorting
            className={cn(
              "cl-mono cursor-pointer border-b border-rule px-1 py-1 text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute",
              "data-[hovered]:text-ink",
            )}
          >
            {({ sortDirection }) => (
              <span className="inline-flex items-center gap-1">
                {column}
                {sortDirection && (
                  <span aria-hidden="true">
                    {sortDirection === "ascending" ? "▲" : "▼"}
                  </span>
                )}
              </span>
            )}
          </Column>
        ))}
      </TableHeader>
      <TableBody items={rows.map((row) => ({ ...row, key: row.id }))}>
        {(row) => (
          <Row
            id={row.id}
            className="border-b border-rule/50 data-[hovered]:bg-highlight"
          >
            {columns.map((column) => (
              <Cell key={column} className="px-1 py-0.5 align-top">
                {column === "title" ? (
                  <button
                    type="button"
                    className="cl-mono cursor-pointer truncate text-left text-[12px] text-ink underline-offset-2 hover:text-accent hover:underline"
                    onClick={() => onOpenPage(row.path)}
                  >
                    {row.title ?? row.path}
                  </button>
                ) : SYSTEM_COLUMNS.has(column) ? (
                  <span className="cl-mono block truncate px-1 py-0.5 text-[12px] text-ink-2">
                    {formatCellValue(
                      (row.columns as Record<string, CellValue>)[column] ??
                        null,
                    )}
                  </span>
                ) : (
                  <EditableCell
                    value={
                      (row.columns as Record<string, CellValue>)[column] ?? null
                    }
                    definition={
                      definition.properties[column] ?? { type: "text" }
                    }
                    onCommit={(value, hint) =>
                      onCommitCell(row, column, value, hint)
                    }
                  />
                )}
              </Cell>
            ))}
          </Row>
        )}
      </TableBody>
    </Table>
  );

  const groups: GroupResult[] | null =
    output?.shape === "grouped" ? output.groups : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-3 border-b border-rule pb-2">
        <h1 className="cl-mono text-[13px] uppercase tracking-[0.14em] text-ink">
          {definition.name}
        </h1>
        <nav aria-label="Views" className="flex gap-1">
          {(definition.views ?? []).map((v) => (
            <button
              key={v.name}
              type="button"
              className={cn(
                "cl-mono border px-2 py-0.5 text-[11px] uppercase tracking-[0.08em]",
                v.name === activeView
                  ? "border-accent text-accent"
                  : "border-rule text-ink-mute hover:text-ink",
              )}
              onClick={() => onViewChange(v.name)}
            >
              {v.name}
            </button>
          ))}
        </nav>
      </div>

      {groups ? (
        <div className="flex flex-col gap-4">
          {groups.map((group) => {
            const key =
              group.key == null
                ? "(empty)"
                : formatCellValue(group.key as CellValue);
            return (
              <section key={key}>
                <header className="mb-1 flex items-baseline gap-2 border-b border-rule pb-1">
                  <span className="cl-mono text-[12px] uppercase tracking-[0.1em] text-ink">
                    {key}
                  </span>
                  <span className="cl-mono text-[10px] text-ink-mute">
                    {group.total} row{group.total === 1 ? "" : "s"}
                  </span>
                  {group.aggregates.map((value, i) => (
                    <span
                      key={i}
                      className="cl-mono border border-rule px-1.5 py-[1px] text-[10px] text-ink-2"
                    >
                      {aggregateLabel(definition, activeView, i)}{" "}
                      {formatCellValue(value as CellValue)}
                    </span>
                  ))}
                </header>
                {grid(group.rows, `${definition.name} — ${key}`)}
              </section>
            );
          })}
        </div>
      ) : (
        grid(
          output?.shape === "flat" ? output.rows : [],
          `${definition.name} — ${activeView}`,
        )
      )}
    </div>
  );
}

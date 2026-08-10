import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";
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
  BaseMemberCapability,
  BaseMemberDiagnostic,
  GroupResult,
  PropertyType,
  QueryOutput,
  QueryRow,
  SortKey,
} from "#/api/bases";
import { Button, buttonStyles } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { BaseMemberDraft } from "./BaseMemberDraft";
import { type CellValue, formatCellValue } from "./cells/types";
import { canSort } from "./definition-model";
import { EditableCell } from "./EditableCell";
import { asciiCaseFold } from "./local-validation";
import type {
  BaseMemberDraftField,
  BaseMemberDraftValue,
} from "./member-draft";

export interface BaseTableViewHandle {
  /**
   * Focuses the active saved-view button, falling back to the first rendered
   * React Aria table when the view switcher has no enabled control.
   */
  focusEntry(): boolean;
}

export interface BaseTableViewProps {
  definition: BaseDetailResponse;
  activeView: string;
  onViewChange: (name: string) => void;
  output: QueryOutput | undefined;
  /** When set without cached output, the grid is replaced by an error banner. */
  viewError?: string;
  viewLoading?: boolean;
  sort: SortKey[] | undefined;
  onSortChange: (sort: SortKey[] | undefined) => void;
  onOpenPage: (path: string) => void;
  configureSlug?: string;
  onCommitCell: (
    row: QueryRow,
    key: string,
    value: CellValue,
    hint?: PropertyType,
  ) => void;
  readOnly?: boolean;
  memberCapability?: BaseMemberCapability;
  memberDraftFields?: BaseMemberDraftField[];
  memberDraftOpen?: boolean;
  memberSaving?: boolean;
  memberDiagnostics?: BaseMemberDiagnostic[];
  memberError?: string;
  memberNotice?: string;
  projects?: string[];
  onAddMember?: () => void;
  onSaveMember?: (value: BaseMemberDraftValue) => void;
  onCancelMember?: () => void;
  onMemberEdit?: () => void;
  focusCreatedId?: string;
  onCreatedRowFocused?: (createdId: string) => void;
}

interface ActiveCell {
  rowId: string;
  column: string;
  view: string;
}
interface ForwardFocusRequest {
  token: number;
  view: string;
  rowId: string;
  node: HTMLButtonElement | null;
  ref: (node: HTMLButtonElement | null) => void;
}

interface CreatedFocusRequest {
  id: string;
  view: string;
}


/**
 * System fields render read-only — the complete contract, mirroring
 * `SYSTEM_FIELDS` in `src/vault/base.rs`. Only *declared* properties reach
 * an editor; anything else (system metadata, undeclared keys) is inert.
 */
const SYSTEM_COLUMNS: Record<string, boolean> = {
  id: true,
  path: true,
  title: true,
  kind: true,
  project: true,
  tags: false,
  aliases: false,
  created_at: true,
  updated_at: true,
  journal_date: true,
  word_count: true,
};

const EMPTY_PROPERTIES: NonNullable<BaseDetailResponse["properties"]> = {};

function aggregateLabel(
  definition: BaseDetailResponse,
  viewName: string,
  index: number,
): string {
  const equivalentViewName = asciiCaseFold(viewName);
  const view = definition.views?.find(
    (candidate) => asciiCaseFold(candidate.name) === equivalentViewName,
  );
  const agg = view?.aggregates?.[index];
  if (!agg) return "";
  return agg.field ? `${agg.fn}(${agg.field})` : agg.fn;
}

/**
 * The Vessel data grid: one react-aria `Table` per (group of) rows, column
 * sorting mapped to ordered query sort keys, group header rows carrying
 * aggregate chips. Purely presentational — data and commits flow through
 * props (`BaseTable` wires the queries).
 */
export const BaseTableView = forwardRef<
  BaseTableViewHandle,
  BaseTableViewProps
>(function BaseTableView({
  definition,
  activeView,
  onViewChange,
  output,
  viewError,
  viewLoading,
  sort,
  onSortChange,
  onOpenPage,
  configureSlug,
  onCommitCell,
  readOnly = false,
  memberCapability,
  memberDraftFields = [],
  memberDraftOpen = false,
  memberSaving = false,
  memberDiagnostics = [],
  memberError,
  memberNotice,
  projects = [],
  onAddMember,
  onSaveMember,
  onCancelMember,
  onMemberEdit,
  focusCreatedId,
  onCreatedRowFocused,
}, ref) {
  const equivalentActiveView = asciiCaseFold(activeView);
  const view = definition.views?.find(
    (candidate) => asciiCaseFold(candidate.name) === equivalentActiveView,
  );
  const columns =
    view?.columns && view.columns.length > 0 ? view.columns : ["title"];
  const properties = definition.properties ?? EMPTY_PROPERTIES;
  const evaluationIdentity = useMemo(
    () =>
      JSON.stringify({
        revision: definition.revision,
        view: equivalentActiveView,
        columns: view?.columns ?? ["title"],
        grouping: view?.group_by ?? null,
        aggregates: view?.aggregates ?? [],
        sort: sort === undefined ? "inherited" : sort,
        outputShape: output?.shape ?? null,
      }),
    [
      definition.revision,
      equivalentActiveView,
      output?.shape,
      sort,
      view?.aggregates,
      view?.columns,
      view?.group_by,
    ],
  );
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const activeViewIdentityRef = useRef(equivalentActiveView);
  const nextForwardFocusToken = useRef(0);
  const pendingForwardFocus = useRef<ForwardFocusRequest | undefined>(
    undefined,
  );
  const [forwardFocusRequest, setForwardFocusRequest] = useState<
    ForwardFocusRequest | undefined
  >(undefined);
  const editableColumns = columns.filter(
    (column) =>
      SYSTEM_COLUMNS[column] === undefined && properties[column] !== undefined,
  );
  const nextEditableColumn = (column: string): string | undefined => {
    const index = editableColumns.indexOf(column);
    return index < 0 ? undefined : editableColumns[index + 1];
  };
  const activeRowId = activeCell?.rowId;
  const activeCellIsRendered =
    activeCell !== null &&
    asciiCaseFold(activeCell.view) === equivalentActiveView &&
    !readOnly &&
    !memberDraftOpen &&
    !viewError &&
    !viewLoading &&
    editableColumns.includes(activeCell.column) &&
    (output?.shape === "flat"
      ? output.rows.some((row) => String(row.id) === activeRowId)
      : output?.shape === "grouped" &&
        output.groups.some((group) =>
          group.rows.some((row) => String(row.id) === activeRowId),
        ));


  useEffect(() => {
    if (activeCell && !activeCellIsRendered) {
      setActiveCell(null);
    }
  }, [activeCell, activeCellIsRendered]);
  const memberBlockerId = useId();
  const createdTitleRef = useRef<HTMLButtonElement | null>(null);
  const focusedCreatedId = useRef<string | undefined>(undefined);
  const createdFocusTimer = useRef<number | undefined>(undefined);
  const createdFocusRequest = useRef<CreatedFocusRequest | undefined>(
    focusCreatedId
      ? { id: focusCreatedId, view: equivalentActiveView }
      : undefined,
  );
  const createdFocusBlocked = useRef(Boolean(viewError || viewLoading));
  const createdRowFocusedHandler = useRef(onCreatedRowFocused);
  const viewRootRef = useRef<HTMLDivElement | null>(null);
  const activeViewControlRef = useRef<HTMLButtonElement | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      focusEntry() {
        const target =
          activeViewControlRef.current ??
          viewRootRef.current?.querySelector<HTMLElement>(
            '[role="grid"], table',
          );
        if (
          !target ||
          !target.isConnected ||
          (target instanceof HTMLButtonElement &&
            (target.disabled ||
              target.getAttribute("aria-disabled") === "true"))
        ) {
          return false;
        }
        if (!(target instanceof HTMLButtonElement)) {
          target.tabIndex = -1;
        }
        target.focus();
        return (
          document.activeElement === target ||
          target.contains(document.activeElement)
        );
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const focusIsBlocked = Boolean(viewError || viewLoading);
    createdFocusBlocked.current = focusIsBlocked;
    createdRowFocusedHandler.current = onCreatedRowFocused;
    if (focusIsBlocked && createdFocusTimer.current !== undefined) {
      window.clearTimeout(createdFocusTimer.current);
      createdFocusTimer.current = undefined;
    }
    const request = createdFocusRequest.current;
    if (!focusCreatedId) {
      createdFocusRequest.current = undefined;
      focusedCreatedId.current = undefined;
    } else if (!request || request.id !== focusCreatedId) {
      createdFocusRequest.current = {
        id: focusCreatedId,
        view: equivalentActiveView,
      };
    }
  }, [
    equivalentActiveView,
    focusCreatedId,
    onCreatedRowFocused,
    viewError,
    viewLoading,
  ]);

  const setCreatedTitleRef = useCallback(
    (node: HTMLButtonElement | null) => {
      createdTitleRef.current = node;
      if (!node) {
        if (createdFocusTimer.current !== undefined) {
          window.clearTimeout(createdFocusTimer.current);
          createdFocusTimer.current = undefined;
        }
        return;
      }
      const request = createdFocusRequest.current;
      if (
        !request ||
        request.view !== activeViewIdentityRef.current ||
        createdFocusBlocked.current ||
        focusedCreatedId.current === request.id ||
        createdFocusTimer.current !== undefined
      ) {
        return;
      }

      // Entering a React Aria Table initializes its selection manager, whose
      // pending effect focuses the row. Prime that state, then restore the
      // requested descendant focus after the row effect has settled.
      node.focus();
      const { id: createdId, view: requestView } = request;
      createdFocusTimer.current = window.setTimeout(() => {
        createdFocusTimer.current = undefined;
        const current = createdFocusRequest.current;
        if (
          createdFocusBlocked.current ||
          createdTitleRef.current !== node ||
          current?.id !== createdId ||
          current.view !== requestView ||
          activeViewIdentityRef.current !== requestView ||
          !node.isConnected
        ) {
          return;
        }
        node.focus();
        queueMicrotask(() => {
          const latest = createdFocusRequest.current;
          if (
            !createdFocusBlocked.current &&
            createdTitleRef.current === node &&
            latest?.id === createdId &&
            latest.view === requestView &&
            activeViewIdentityRef.current === requestView &&
            node.isConnected &&
            document.activeElement === node
          ) {
            focusedCreatedId.current = createdId;
            createdRowFocusedHandler.current?.(createdId);
          }
        });
      }, 0);
    },
    [],
  );
  const setForwardTitleRef = useCallback(
    (token: number, node: HTMLButtonElement | null) => {
      const request = pendingForwardFocus.current;
      if (!request || request.token !== token) return;
      if (!node) {
        request.node = null;
        return;
      }
      request.node = node;
      const { rowId, view: requestView } = request;
      queueMicrotask(() => {
        const current = pendingForwardFocus.current;
        if (
          !current ||
          current.token !== token ||
          current.rowId !== rowId ||
          current.view !== requestView ||
          current.node !== node ||
          activeViewIdentityRef.current !== requestView ||
          !node.isConnected
        ) {
          return;
        }
        pendingForwardFocus.current = undefined;
        setForwardFocusRequest((requestState) =>
          requestState?.token === token ? undefined : requestState,
        );
        node.focus();
      });
    },
    [],
  );
  useLayoutEffect(() => {
    activeViewIdentityRef.current = equivalentActiveView;
    const request = pendingForwardFocus.current;
    if (!request) return;

    const requestRowIsRendered =
      output?.shape === "flat"
        ? output.rows.some((row) => String(row.id) === request.rowId)
        : output?.shape === "grouped" &&
          output.groups.some((group) =>
            group.rows.some((row) => String(row.id) === request.rowId),
          );
    const titleCanRender =
      columns.includes("title") &&
      !readOnly &&
      !memberDraftOpen &&
      !viewError &&
      !viewLoading;
    const createdTitleIsRendered =
      titleCanRender &&
      focusCreatedId !== undefined &&
      (output?.shape === "flat"
        ? output.rows.some((row) => String(row.id) === focusCreatedId)
        : output?.shape === "grouped" &&
          output.groups.some((group) =>
            group.rows.some((row) => String(row.id) === focusCreatedId),
          ));

    const fallbackNode = createdTitleIsRendered
      ? createdTitleRef.current
      : request.view === equivalentActiveView &&
          requestRowIsRendered &&
          titleCanRender
        ? undefined
        : viewRootRef.current;
    if (fallbackNode === undefined) return;

    pendingForwardFocus.current = undefined;
    setForwardFocusRequest((current) =>
      current?.token === request.token ? undefined : current,
    );
    if (!fallbackNode) return;
    const committedView = equivalentActiveView;
    queueMicrotask(() => {
      if (
        nextForwardFocusToken.current === request.token &&
        activeViewIdentityRef.current === committedView &&
        fallbackNode.isConnected
      ) {
        fallbackNode.focus();
      }
    });
  }, [
    columns,
    equivalentActiveView,
    forwardFocusRequest,
    focusCreatedId,
    memberDraftOpen,
    output,
    readOnly,
    viewError,
    viewLoading,
  ]);
  const memberBlocker =
    memberCapability?.enabled === true
      ? undefined
      : (memberCapability?.blockers?.[0]?.message ??
        "Member creation is unavailable for this view.");
  const memberAddDisabled =
    memberDraftOpen ||
    memberSaving ||
    memberCapability?.enabled !== true;

  useEffect(() => {
    if (focusCreatedId) {
      setCreatedTitleRef(createdTitleRef.current);
    }
  }, [
    focusCreatedId,
    output,
    setCreatedTitleRef,
    viewError,
    viewLoading,
  ]);

  useEffect(
    () => () => {
      if (createdFocusTimer.current !== undefined) {
        window.clearTimeout(createdFocusTimer.current);
      }
    },
    [],
  );

  const primarySort = sort?.[0];
  const sortDescriptor = primarySort
    ? {
        column: primarySort.field,
        direction:
          primarySort.dir === "desc"
            ? ("descending" as const)
            : ("ascending" as const),
      }
    : undefined;

  const grid = (
    rows: QueryRow[],
    label: string,
    cacheIdentity: string,
  ) => (
    <Table
      key={cacheIdentity}
      aria-label={label}
      sortDescriptor={readOnly ? undefined : sortDescriptor}
      onSortChange={
        readOnly
          ? undefined
          : (descriptor) =>
              onSortChange([
                {
                  field: String(descriptor.column),
                  dir:
                    descriptor.direction === "descending" ? "desc" : "asc",
                },
              ])
      }
      className="w-full border-collapse"
    >
      <TableHeader>
        {columns.map((column) => {
          const allowsSorting =
            !readOnly &&
            (SYSTEM_COLUMNS[column] === true ||
              (properties[column] != null && canSort(properties[column].type)));
          return (
            <Column
              key={column}
              id={column}
              isRowHeader={column === columns[0]}
              allowsSorting={allowsSorting}
              className={cn(
                "cl-mono border-b border-rule px-1 py-1 text-left text-[10px] uppercase tracking-[0.12em] text-ink-mute",
                allowsSorting && "cursor-pointer data-[hovered]:text-ink",
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
          );
        })}
      </TableHeader>
      <TableBody
        key={`${cacheIdentity}:${memberDraftOpen ? "draft" : "active"}`}
        dependencies={[
          activeCell,
          evaluationIdentity,
          focusCreatedId,
          memberDraftOpen,
          readOnly,
        ]}
        items={rows}
      >
        {(row) => (
          <Row
            id={row.id}
            className="border-b border-rule/50 data-[hovered]:bg-highlight"
          >
            {columns.map((column) => (
              <Cell key={column} className="px-1 py-0.5 align-top">
                {column === "title" ? (
                  readOnly || memberDraftOpen ? (
                    <span className="cl-mono block truncate px-1 py-0.5 text-[12px] text-ink">
                      {row.title ?? row.path}
                    </span>
                  ) : (
                    <button
                      ref={
                        row.id === focusCreatedId
                          ? setCreatedTitleRef
                          : forwardFocusRequest?.view ===
                                equivalentActiveView &&
                              String(row.id) === forwardFocusRequest.rowId
                            ? forwardFocusRequest.ref
                            : undefined
                      }
                      type="button"
                      className="cl-mono cursor-pointer truncate text-left text-[12px] text-ink underline-offset-2 hover:text-accent hover:underline"
                      onClick={() => onOpenPage(row.path)}
                    >
                      {row.title ?? row.path}
                    </button>
                  )
                ) : !readOnly &&
                  !memberDraftOpen &&
                  SYSTEM_COLUMNS[column] === undefined &&
                  properties[column] ? (
                  <EditableCell
                    value={
                      (row.columns as Record<string, CellValue>)[column] ?? null
                    }
                    definition={properties[column]}
                    isEditing={
                      activeCell?.rowId === String(row.id) &&
                      activeCell.column === column &&
                      asciiCaseFold(activeCell.view) === equivalentActiveView
                    }
                    onEdit={() => {
                      pendingForwardFocus.current = undefined;
                      nextForwardFocusToken.current += 1;
                      setForwardFocusRequest(undefined);
                      setActiveCell({
                        rowId: String(row.id),
                        column,
                        view: activeView,
                      });
                    }}
                    onCancel={() => {
                      if (pendingForwardFocus.current) return;
                      pendingForwardFocus.current = undefined;
                      setForwardFocusRequest(undefined);
                      setActiveCell(null);
                    }}
                    onCommit={(value, hint) => {
                      pendingForwardFocus.current = undefined;
                      nextForwardFocusToken.current += 1;
                      setForwardFocusRequest(undefined);
                      setActiveCell(null);
                      onCommitCell(row, column, value, hint);
                    }}
                    onCommitNext={(value, hint) => {
                      const token = nextForwardFocusToken.current + 1;
                      nextForwardFocusToken.current = token;
                      pendingForwardFocus.current = undefined;
                      setForwardFocusRequest(undefined);
                      onCommitCell(row, column, value, hint);
                      const nextColumn = nextEditableColumn(column);
                      if (nextColumn) {
                        setActiveCell({
                          rowId: String(row.id),
                          column: nextColumn,
                          view: activeView,
                        });
                        return;
                      }
                      const rowIndex = rows.findIndex(
                        (candidate) => String(candidate.id) === String(row.id),
                      );
                      const targetRowId = String(
                        rows[rowIndex + 1]?.id ?? row.id,
                      );
                      const request: ForwardFocusRequest = {
                        token,
                        view: equivalentActiveView,
                        rowId: targetRowId,
                        node: null,
                        ref: (node) => setForwardTitleRef(token, node),
                      };
                      pendingForwardFocus.current = request;
                      setForwardFocusRequest(request);
                      setActiveCell(null);
                    }}
                  />
                ) : (
                  // System fields and undeclared keys are read-only.
                  <span className="cl-mono block truncate px-1 py-0.5 text-[12px] text-ink-2">
                    {formatCellValue(
                      (row.columns as Record<string, CellValue>)[column] ??
                        null,
                    )}
                  </span>
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
  const capStatus = (() => {
    if (output?.shape === "flat" && output.rows.length < output.total) {
      const excluded = output.total - output.rows.length;
      return `Showing ${output.rows.length} of ${output.total} rows; ${excluded} rows excluded by the current limit.`;
    }
    if (output?.shape === "grouped") {
      let shown = 0;
      let total = 0;
      for (const group of output.groups) {
        shown += group.rows.length;
        total += group.total;
      }
      if (shown < total) {
        return `Showing ${shown} of ${total} rows across groups; ${total - shown} rows excluded by the current per-group limit.`;
      }
    }
    return undefined;
  })();
  const shouldRenderGrid =
    output !== undefined || (!viewError && !viewLoading);

  return (
    <div
      ref={viewRootRef}
      role="region"
      aria-label={`${definition.name} table view`}
      tabIndex={-1}
      className="flex flex-col gap-3"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-rule pb-2">
        <h1 className="cl-mono text-[13px] uppercase tracking-[0.14em] text-ink">
          {definition.name}
        </h1>
        <nav aria-label="Views" className="flex flex-wrap gap-1">
          {(definition.views ?? []).map((v) =>
            readOnly ? (
              <span
                key={v.name}
                className={cn(
                  "cl-mono border px-2 py-0.5 text-[11px] uppercase tracking-[0.08em]",
                  asciiCaseFold(v.name) === equivalentActiveView
                    ? "border-accent text-accent"
                    : "border-rule text-ink-mute",
                )}
              >
                {v.name}
              </span>
            ) : (
              <button
                ref={
                  asciiCaseFold(v.name) === equivalentActiveView
                    ? activeViewControlRef
                    : undefined
                }
                key={v.name}
                type="button"
                className={cn(
                  "cl-mono border px-2 py-0.5 text-[11px] uppercase tracking-[0.08em] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
                  asciiCaseFold(v.name) === equivalentActiveView
                    ? "border-accent text-accent"
                    : "border-rule text-ink-mute hover:text-ink",
                )}
                aria-current={
                  asciiCaseFold(v.name) === equivalentActiveView
                    ? "page"
                    : undefined
                }
                onClick={() => onViewChange(v.name)}
              >
                {v.name}
              </button>
            ),
          )}
        </nav>
        {!readOnly && configureSlug && (
          <Link
            to="/bases/$slug/edit"
            params={{ slug: configureSlug }}
            className={buttonStyles("secondary", "sm", "ml-auto")}
            aria-label={`Configure ${definition.name}`}
          >
            <Settings aria-hidden="true" className="h-3.5 w-3.5" />
            Configure
          </Link>
        )}
        {!readOnly ? (
          <>
            {/* Reset React Aria's press responder after an in-flight operation. */}
            <Button key={memberSaving ? "add-busy" : "add-ready"}
              variant="secondary"
              size="sm"
              className={configureSlug ? undefined : "ml-auto"}
              isDisabled={memberAddDisabled}
              aria-describedby={memberBlocker ? memberBlockerId : undefined}
              onPress={onAddMember}
            >
              Add member
            </Button>
            {memberBlocker ? (
              <span id={memberBlockerId} className="sr-only">
                {memberBlocker}
              </span>
            ) : null}
          </>
        ) : null}
      </div>
      {memberDraftOpen && onSaveMember && onCancelMember ? (
        <BaseMemberDraft
          fields={memberDraftFields}
          projects={projects}
          isSaving={memberSaving}
          diagnostics={memberDiagnostics}
          summaryError={memberError}
          onSave={onSaveMember}
          onCancel={onCancelMember}
          onChange={onMemberEdit}
        />
      ) : null}

      {memberNotice ? (
        <p
          role="status"
          className="cl-mono border border-rule px-3 py-2 text-[11px] text-ink-2"
        >
          {memberNotice}
        </p>
      ) : null}

      {viewError ? (
        <p
          role="alert"
          className="cl-mono border border-warn px-3 py-2 text-[11px] text-warn"
        >
          View failed: {viewError}
        </p>
      ) : null}
      {viewLoading ? (
        <p
          role="status"
          aria-label="View loading"
          className="cl-mono px-1 py-2 text-[11px] text-ink-mute"
        >
          Loading…
        </p>
      ) : null}
      {capStatus ? (
        <p
          role="status"
          aria-label="Result limit"
          className="cl-mono border border-rule px-3 py-2 text-[11px] text-ink-2"
        >
          {capStatus}
        </p>
      ) : null}
      {shouldRenderGrid ? (
        groups ? (
          <div className="flex flex-col gap-4">
            {groups.map((group, index) => {
              const key =
                group.key == null
                  ? "(empty)"
                  : formatCellValue(group.key as CellValue);
              const groupIdentity = `${evaluationIdentity}:group:${index}:${JSON.stringify(group.key)}`;
              return (
                <section key={groupIdentity}>
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
                  {grid(
                    group.rows,
                    `${definition.name} — ${key}`,
                    groupIdentity,
                  )}
                </section>
              );
            })}
          </div>
        ) : (
          grid(
            output?.shape === "flat" ? output.rows : [],
            `${definition.name} — ${activeView}`,
            `${evaluationIdentity}:flat`,
          )
        )
      ) : null}
    </div>
  );
});

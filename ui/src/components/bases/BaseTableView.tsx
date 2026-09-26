import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronRight, Settings } from "lucide-react";
import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Cell,
  Column,
  Row,
  Table,
  TableBody,
  TableHeader,
} from "react-aria-components";
import type {
  Aggregate,
  BaseDetailResponse,
  BaseMemberCapability,
  BaseMemberDiagnostic,
  GroupResult,
  PropertyType,
  QueryOutput,
  QueryRow,
  SortKey,
} from "#/api/bases";
import { FooterControls } from "#/components/codex/FooterControls";
import { Tick } from "#/components/codex/Tick";
import { Button, buttonStyles } from "#/components/ui/button";
import { Switch } from "#/components/ui/switch";
import { useTableCompact } from "#/hooks/useTableCompact";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { ArchiveRowDialog } from "./ArchiveRowDialog";
import { BaseHeaderMenu } from "./BaseHeaderMenu";
import { BaseMemberDraft } from "./BaseMemberDraft";
import {
  FilterPicker,
  GroupPicker,
  type PickerColumn,
  SortPicker,
} from "./BasePickers";
import {
  CellContextTrigger,
  RowActionsButton,
  type RowContextTarget,
  type RowMenuActions,
  type RowMenuCell,
} from "./BaseRowMenu";
import { type CellValue, formatCellValue } from "./cells/types";
import { canGroup, canSort } from "./definition-model";
import { EditableCell } from "./EditableCell";
import type { EmbedScrollCap } from "./embed-query";
import { FieldsPopover } from "./FieldsPopover";
import { groupCollapseKey, groupIdentity } from "./group-collapse";
import { asciiCaseFold, presentationFieldIdentity } from "./local-validation";
import type {
  BaseMemberDraftField,
  BaseMemberDraftValue,
} from "./member-draft";
import { useIdentifiedRows } from "./ordered-list";
import {
  headerFilterPresets,
  headerOptionOverflow,
  quickFilterType,
} from "./quick-filters";
import { useGroupCollapse } from "./useGroupCollapse";
import type { OverridesSaveState } from "./useViewOverrides";
import { ViewOverridesStrip } from "./ViewOverridesStrip";
import {
  EMPTY_OVERRIDES,
  type GroupOverride,
  type QuickFilter,
  type ViewOverridesState,
} from "./view-overrides";

const EMPTY_AGGREGATES: readonly Aggregate[] = [];
const IDLE_SAVE: OverridesSaveState = { phase: "idle" };
const noop = () => {};

export interface BaseTableViewHandle {
  /**
   * Focuses the active saved-view button, falling back to the first rendered
   * React Aria table when the view switcher has no enabled control.
   */
  focusEntry(): boolean;
  /** Focuses one row's title button; false when that row is not rendered. */
  focusRow(rowId: string): boolean;
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
  /** The standalone `/bases/$slug` screen: serif header, Compact switch,
   *  view pickers and footer context. Embeds never set it. */
  screen?: boolean;
  /** Compact folds the Base chrome into one toolbar for an embedded view. */
  chrome?: "full" | "compact";
  /** Controls owned by the surface hosting the table, shown in its toolbar. */
  toolbarActions?: ReactNode;
  /** Windowed loading state, for a compact view that scrolls in place. */
  rowWindow?: {
    /** The authoritative row count, not the rows rendered. */
    total: number | undefined;
    loaded: number;
    hasMore: boolean;
    isLoadingMore: boolean;
    /** Which bound ended the scroll short of the total, if either did. */
    cappedBy: EmbedScrollCap | undefined;
    loadMore(): void;
  };
  onCommitCell: (
    row: QueryRow,
    key: string,
    value: CellValue,
    hint?: PropertyType,
  ) => void;
  readOnly?: boolean;
  memberCapability?: BaseMemberCapability;
  memberDraftFields?: BaseMemberDraftField[];
  memberTitleTemplate?: string;
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
  overrides?: ViewOverridesState;
  onAddQuickFilter?(filter: QuickFilter): void;
  onRemoveQuickFilter?(identity: string): void;
  onSetGroup?(group: GroupOverride | undefined): void;
  onHideColumn?(column: string): void;
  onShowColumn?(column: string): void;
  onShowHiddenColumns?(): void;
  onClearOverrides?(): void;
  onSaveOverrides?(): void;
  onReloadDefinition?(): void;
  overridesSave?: OverridesSaveState;
  onOpenPageInNewTab?(path: string): void;
  onCopyWikilink?(row: QueryRow): void;
  onCopyValue?(value: CellValue): void;
  onDuplicateRow?(row: QueryRow): void;
  /** Resolves once the page is archived; rejects with an Error whose message the dialog shows. */
  onArchiveRow?(row: QueryRow): Promise<void>;
  rowActionError?: string;
}

/** Which system columns a group-by can key on; the rest are unique per row. */
const GROUPABLE_SYSTEM: Record<string, true> = {
  kind: true,
  project: true,
  created_at: true,
  updated_at: true,
  journal_date: true,
};

/** The row whose title takes focus once an archived row leaves the output. */
interface ArchiveFocusRequest {
  removedRowId: string;
  nextRowId: string | undefined;
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
 * `SYSTEM_FIELDS` in `crates/clep-bases/src/base.rs`. Only *declared* properties reach
 * an editor; anything else (system metadata, undeclared keys) is inert.
 */
const SYSTEM_COLUMNS: Record<string, boolean> = {
  id: true,
  path: true,
  title: true,
  kind: true,
  project: true,
  body: false,
  tags: false,
  aliases: false,
  created_at: true,
  updated_at: true,
  journal_date: true,
  word_count: true,
};

interface BodyExcerptCellProps {
  value: CellValue;
  pageLabel: string;
  path: string;
  onOpenPage: (path: string) => void;
}

function BodyExcerptCell({
  value,
  pageLabel,
  path,
  onOpenPage,
}: BodyExcerptCellProps) {
  if (typeof value !== "string" || value.trim() === "") return null;

  return (
    <button
      type="button"
      aria-label={`Open body excerpt for ${pageLabel} in Folio`}
      className={cn(
        "block w-full min-w-0 cursor-pointer truncate rounded-md px-1 py-0.5 text-left text-mute hover:text-accent text-wrap",
        FOCUS_RING_NATIVE,
      )}
      onClick={() => onOpenPage(path)}
    >
      {value}
    </button>
  );
}

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

/** One chip per aggregate value: `${label} ${formattedValue}`, keyed by the
 * view's aggregate identity so it survives reorders. Shared by group headers
 * and the flat-output Totals footer. */
function AggregateChips({
  values,
  definition,
  viewName,
  rows,
}: {
  values: readonly unknown[];
  definition: BaseDetailResponse;
  viewName: string;
  /** `displayAggregateRows` — stable per-index identity for the key. */
  rows: readonly { id: string }[];
}) {
  return (
    <>
      {values.map((value, index) => {
        const label = aggregateLabel(definition, viewName, index);
        const aggregateRow = rows[index];
        return (
          <span
            key={aggregateRow?.id ?? label}
            className="inline-flex h-6 items-center gap-1.5 rounded-full bg-sink px-2.5 text-[12px] text-ink-2 tabular-nums"
          >
            {label} {formatCellValue(value as CellValue)}
          </span>
        );
      })}
    </>
  );
}

/** How near the end of the loaded rows counts as approaching it. */
const APPROACH_PX = 240;
/** A compact embed is a block in someone's document, not a page of its own. */
const VIEWPORT_CLASS = "max-h-[26rem] overflow-auto";

interface ScrollViewportProps {
  enabled: boolean;
  /** Ask for the next window when the content is too short to scroll. Off while
   * groups are folded: folded rows add no height, so autofill would page the
   * whole base. Scroll-driven loading stays live. */
  autofill?: boolean;
  onApproachEnd(): void;
  children: ReactNode;
}

/** Bounds a compact embed's height and reports when the reader nears the end
 * of what has been loaded, so the next window can be fetched before they get
 * there. Full-chrome tables render their rows in the page, unwrapped. */
function ScrollViewport({
  enabled,
  autofill = true,
  onApproachEnd,
  children,
}: ScrollViewportProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const approach = useRef(onApproachEnd);
  approach.current = onApproachEnd;

  const check = useCallback((node: HTMLElement) => {
    const remaining = node.scrollHeight - node.scrollTop - node.clientHeight;
    if (remaining <= APPROACH_PX) approach.current();
  }, []);

  // A window shorter than the viewport leaves nothing to scroll, so the next
  // one has to be asked for without a scroll event.
  useEffect(() => {
    const node = ref.current;
    // A zero height is an unmeasured viewport, not an empty one.
    if (!enabled || !autofill || !node || node.clientHeight === 0) return;
    if (node.scrollHeight <= node.clientHeight) approach.current();
  });

  if (!enabled) return children;
  return (
    <div
      ref={ref}
      data-testid="base-table-scroller"
      className={VIEWPORT_CLASS}
      onScroll={(event) => check(event.currentTarget)}
    >
      {children}
    </div>
  );
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
>(function BaseTableView(
  {
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
    chrome = "full",
    screen = false,
    toolbarActions,
    rowWindow,
    onCommitCell,
    readOnly = false,
    memberCapability,
    memberDraftFields = [],
    memberTitleTemplate,
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
    overrides = EMPTY_OVERRIDES,
    onAddQuickFilter,
    onRemoveQuickFilter,
    onSetGroup,
    onHideColumn,
    onShowColumn,
    onShowHiddenColumns,
    onClearOverrides,
    onSaveOverrides,
    onReloadDefinition,
    overridesSave = IDLE_SAVE,
    onOpenPageInNewTab,
    onCopyWikilink,
    onCopyValue,
    onDuplicateRow,
    onArchiveRow,
    rowActionError,
  },
  ref,
) {
  const compact = chrome === "compact";
  // Embeds are always dense (user ruling); the screen follows its switch.
  const [compactRows, setCompactRows] = useTableCompact("bases", false);
  const dense = !screen || compactRows;
  const equivalentActiveView = asciiCaseFold(activeView);
  const view = definition.views?.find(
    (candidate) => asciiCaseFold(candidate.name) === equivalentActiveView,
  );
  const { rows: displayAggregateRows } = useIdentifiedRows(
    view?.aggregates ?? EMPTY_AGGREGATES,
    "table-aggregate",
  );
  const columns =
    view?.columns && view.columns.length > 0 ? view.columns : ["title"];
  const hiddenColumns = overrides.hiddenColumns;
  const visibleColumns = useMemo(
    () => columns.filter((column) => !hiddenColumns.includes(column)),
    [columns, hiddenColumns],
  );
  const displayLabelsByIdentity = useMemo(() => {
    const result = new Map<string, string>();
    for (const [field, label] of Object.entries(view?.labels ?? {})) {
      const identity = presentationFieldIdentity(field);
      if (identity !== undefined) result.set(identity, label);
    }
    return result;
  }, [view?.labels]);
  const displayLabelForColumn = (column: string): string => {
    const identity = presentationFieldIdentity(column);
    return identity === undefined
      ? column
      : (displayLabelsByIdentity.get(identity) ?? column);
  };
  const properties = useMemo(
    () =>
      new Map(
        (definition.properties ?? []).map(({ key, definition }) => [
          key,
          definition,
        ]),
      ),
    [definition.properties],
  );
  const evaluationIdentity = useMemo(
    () =>
      JSON.stringify({
        revision: definition.revision,
        view: equivalentActiveView,
        columns: view?.columns ?? ["title"],
        hidden: hiddenColumns,
        grouping: view?.group_by ?? null,
        groupOverride: overrides.group ?? null,
        aggregates: view?.aggregates ?? [],
        sort: sort === undefined ? "inherited" : sort,
        outputShape: output?.shape ?? null,
      }),
    [
      definition.revision,
      equivalentActiveView,
      hiddenColumns,
      output?.shape,
      overrides.group,
      sort,
      view?.aggregates,
      view?.columns,
      view?.group_by,
    ],
  );
  /** The column the rows are actually grouped by, override before saved view. */
  const effectiveGroup = overrides.group
    ? overrides.group.kind === "by"
      ? overrides.group.field
      : undefined
    : (view?.group_by ?? undefined);
  const groupCollapse = useGroupCollapse(
    groupCollapseKey(definition.slug, activeView, effectiveGroup ?? ""),
  );
  const groupPanelIdBase = useId();
  const groupableColumn = (column: string) =>
    SYSTEM_COLUMNS[column] !== undefined
      ? GROUPABLE_SYSTEM[column] === true
      : canGroup(properties.get(column)?.type);
  const columnAllowsSorting = (column: string) => {
    const property = properties.get(column);
    return (
      !readOnly &&
      (SYSTEM_COLUMNS[column] !== undefined
        ? SYSTEM_COLUMNS[column]
        : property != null && canSort(property.type))
    );
  };
  /** One source for the header `⋯` menus and the view-bar pickers. */
  const pickerColumn = (column: string): PickerColumn => {
    const property = properties.get(column);
    const label = displayLabelForColumn(column);
    return {
      column,
      label,
      allowsSorting: columnAllowsSorting(column),
      groupable: groupableColumn(column),
      presets: headerFilterPresets(
        column,
        quickFilterType(column, property),
        property,
        label,
      ),
      optionOverflow: headerOptionOverflow(property),
    };
  };
  const [activeCell, setActiveCell] = useState<ActiveCell | null>(null);
  const activeViewIdentityRef = useRef(equivalentActiveView);
  const nextForwardFocusToken = useRef(0);
  const pendingForwardFocus = useRef<ForwardFocusRequest | undefined>(
    undefined,
  );
  const [forwardFocusRequest, setForwardFocusRequest] = useState<
    ForwardFocusRequest | undefined
  >(undefined);
  const editableColumns = visibleColumns.filter(
    (column) => SYSTEM_COLUMNS[column] === undefined && properties.has(column),
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

  const focusEntry = useCallback(() => {
    const target =
      activeViewControlRef.current ??
      viewRootRef.current?.querySelector<HTMLElement>('[role="grid"], table');
    if (
      !target?.isConnected ||
      (target instanceof HTMLButtonElement &&
        (target.disabled || target.getAttribute("aria-disabled") === "true"))
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
  }, []);

  // The title buttons carry the row id rather than a ref, so registering them
  // cannot disturb the created/forward focus refs already on that element.
  const focusRow = useCallback((rowId: string) => {
    const button = viewRootRef.current?.querySelector<HTMLButtonElement>(
      `[data-row-title="${CSS.escape(rowId)}"]`,
    );
    if (!button?.isConnected) return false;
    button.focus();
    return document.activeElement === button;
  }, []);

  useImperativeHandle(ref, () => ({ focusEntry, focusRow }), [
    focusEntry,
    focusRow,
  ]);

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

  const setCreatedTitleRef = useCallback((node: HTMLButtonElement | null) => {
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
  }, []);
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
    if (!request || request.token !== forwardFocusRequest?.token) return;

    const requestRowIsRendered =
      output?.shape === "flat"
        ? output.rows.some((row) => String(row.id) === request.rowId)
        : output?.shape === "grouped" &&
          output.groups.some((group) =>
            group.rows.some((row) => String(row.id) === request.rowId),
          );
    const titleCanRender =
      visibleColumns.includes("title") &&
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
    equivalentActiveView,
    forwardFocusRequest,
    focusCreatedId,
    memberDraftOpen,
    output,
    readOnly,
    viewError,
    viewLoading,
    visibleColumns,
  ]);
  const memberBlocker =
    memberCapability?.enabled === true
      ? undefined
      : (memberCapability?.blockers?.[0]?.message ??
        "Member creation is unavailable for this view.");
  const memberAddDisabled =
    memberDraftOpen || memberSaving || memberCapability?.enabled !== true;

  const createdTitleCanReceiveFocus =
    focusCreatedId !== undefined &&
    !viewError &&
    !viewLoading &&
    (output?.shape === "flat"
      ? output.rows.some((row) => String(row.id) === focusCreatedId)
      : output?.shape === "grouped" &&
        output.groups.some((group) =>
          group.rows.some((row) => String(row.id) === focusCreatedId),
        ));
  useEffect(() => {
    if (createdTitleCanReceiveFocus) {
      setCreatedTitleRef(createdTitleRef.current);
    }
  }, [createdTitleCanReceiveFocus, setCreatedTitleRef]);

  useEffect(
    () => () => {
      if (createdFocusTimer.current !== undefined) {
        window.clearTimeout(createdFocusTimer.current);
      }
    },
    [],
  );

  const [contextTarget, setContextTarget] = useState<RowContextTarget | null>(
    null,
  );
  /** The cell section the row's menu shows, when a cell summoned it. */
  const contextCell = (row: QueryRow): RowMenuCell | undefined => {
    const column = contextTarget?.column;
    if (contextTarget?.rowId !== String(row.id) || column === undefined)
      return undefined;
    return {
      column,
      label: displayLabelForColumn(column),
      type: quickFilterType(column, properties.get(column)),
      value: (row.columns as Record<string, CellValue>)[column],
    };
  };
  const [archiveTarget, setArchiveTarget] = useState<QueryRow | null>(null);
  const [archiveFocus, setArchiveFocus] = useState<
    ArchiveFocusRequest | undefined
  >(undefined);
  const rowsInOrder = useMemo<QueryRow[]>(() => {
    if (output?.shape === "flat") return output.rows;
    if (output?.shape === "grouped")
      return output.groups.flatMap((group) => group.rows);
    return [];
  }, [output]);
  // Opening the page is what the title button already does, so a menu holding
  // only that is a button with nothing behind it: the read-only definition
  // preview wires no row actions at all.
  const hasRowActions =
    onOpenPageInNewTab !== undefined ||
    onCopyWikilink !== undefined ||
    onDuplicateRow !== undefined ||
    onArchiveRow !== undefined;
  const rowActions = useMemo<RowMenuActions>(
    () => ({
      onOpenPage,
      onOpenPageInNewTab,
      onCopyWikilink,
      onDuplicateRow,
      // Without a handler there is no dialog to open, so the item stays inert.
      onArchiveRow: onArchiveRow
        ? (row: QueryRow) => setArchiveTarget(row)
        : undefined,
    }),
    [
      onArchiveRow,
      onCopyWikilink,
      onDuplicateRow,
      onOpenPage,
      onOpenPageInNewTab,
    ],
  );

  // The archived row leaves the output only once the refetch lands; until then
  // its successor's title button is not there to take focus.
  useEffect(() => {
    if (!archiveFocus) return;
    if (rowsInOrder.some((row) => String(row.id) === archiveFocus.removedRowId))
      return;
    const { nextRowId } = archiveFocus;
    setArchiveFocus(undefined);
    if (nextRowId === undefined || !focusRow(nextRowId)) focusEntry();
  }, [archiveFocus, focusEntry, focusRow, rowsInOrder]);

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

  const grid = (rows: QueryRow[], label: string, cacheIdentity: string) => (
    <Table
      key={cacheIdentity}
      aria-label={label}
      data-density={dense ? "compact" : "comfortable"}
      sortDescriptor={readOnly ? undefined : sortDescriptor}
      onSortChange={
        readOnly
          ? undefined
          : (descriptor) =>
              onSortChange([
                {
                  field: String(descriptor.column),
                  dir: descriptor.direction === "descending" ? "desc" : "asc",
                },
              ])
      }
      className={cn(
        "w-full border-collapse",
        dense
          ? "text-[12.5px] [--title:13.5px]"
          : "text-[13px] [--title:14.5px]",
      )}
    >
      <TableHeader>
        {visibleColumns.map((column) => {
          const capability = pickerColumn(column);
          const allowsSorting = capability.allowsSorting;
          return (
            <Column
              key={column}
              id={column}
              isRowHeader={column === visibleColumns[0]}
              allowsSorting={allowsSorting}
              className={cn(
                "px-3 text-left text-[12.5px] font-normal text-mute",
                dense ? "h-[34px]" : "h-10",
                allowsSorting && "cursor-pointer data-[hovered]:text-ink",
                // The scroller moves the rows under the header, not past it.
                compact && "sticky top-0 z-[1] bg-ground",
              )}
            >
              {({ sortDirection }) => {
                const label = displayLabelForColumn(column);
                const heading = (
                  <span className="inline-flex items-center gap-1">
                    {label}
                    {sortDirection && (
                      <span aria-hidden="true">
                        {sortDirection === "ascending" ? "↑" : "↓"}
                      </span>
                    )}
                  </span>
                );
                if (readOnly) return heading;
                return (
                  <BaseHeaderMenu
                    column={column}
                    label={label}
                    allowsSorting={allowsSorting}
                    groupable={capability.groupable}
                    groupedByThis={effectiveGroup === column}
                    hideable={column !== "title" && visibleColumns.length > 1}
                    presets={capability.presets}
                    optionOverflow={capability.optionOverflow}
                    onSortChange={onSortChange}
                    onAddQuickFilter={onAddQuickFilter ?? noop}
                    onSetGroup={onSetGroup ?? noop}
                    onHideColumn={onHideColumn ?? noop}
                  >
                    {heading}
                  </BaseHeaderMenu>
                );
              }}
            </Column>
          );
        })}
      </TableHeader>
      <TableBody
        key={`${cacheIdentity}:${memberDraftOpen ? "draft" : "active"}`}
        dependencies={[
          activeCell,
          contextTarget,
          evaluationIdentity,
          focusCreatedId,
          memberDraftOpen,
          onAddQuickFilter,
          onCopyValue,
          readOnly,
          rowActions,
        ]}
        items={rows}
      >
        {(row) => (
          <Row
            id={row.id}
            className={cn(
              "group data-[hovered]:*:bg-sink",
              dense ? "h-8" : "h-[42px]",
            )}
          >
            {visibleColumns.map((column) => {
              const property = properties.get(column);
              return (
                <Cell
                  key={column}
                  className="px-3 align-middle first:rounded-l-[10px] last:rounded-r-[10px]"
                >
                  {/* One menu serves the row; each cell forwards its context
                    events to the `⋯` button that owns it. */}
                  <div className="flex min-w-0 items-center">
                    <CellContextTrigger
                      row={row}
                      column={column}
                      onContextTarget={setContextTarget}
                    >
                      {column === "title" ? (
                        readOnly || memberDraftOpen ? (
                          <span className="block truncate px-1 py-0.5 text-[length:var(--title)] font-medium text-ink">
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
                            data-row-title={String(row.id)}
                            className={cn(
                              "cursor-pointer truncate rounded-md text-left text-[length:var(--title)] font-medium text-ink hover:text-accent",
                              FOCUS_RING_NATIVE,
                            )}
                            onClick={() => onOpenPage(row.path)}
                          >
                            {row.title ?? row.path}
                          </button>
                        )
                      ) : column === "body" ? (
                        <BodyExcerptCell
                          value={
                            (row.columns as Record<string, CellValue>).body ??
                            null
                          }
                          pageLabel={row.title ?? row.path}
                          path={row.path}
                          onOpenPage={onOpenPage}
                        />
                      ) : !readOnly &&
                        !memberDraftOpen &&
                        SYSTEM_COLUMNS[column] === undefined &&
                        property !== undefined ? (
                        <EditableCell
                          value={
                            (row.columns as Record<string, CellValue>)[
                              column
                            ] ?? null
                          }
                          definition={property}
                          isEditing={
                            activeCell?.rowId === String(row.id) &&
                            activeCell.column === column &&
                            asciiCaseFold(activeCell.view) ===
                              equivalentActiveView
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
                              (candidate) =>
                                String(candidate.id) === String(row.id),
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
                        <span className="block truncate px-1 py-0.5 text-mute tabular-nums">
                          {formatCellValue(
                            (row.columns as Record<string, CellValue>)[
                              column
                            ] ?? null,
                          )}
                        </span>
                      )}
                    </CellContextTrigger>
                    {column === visibleColumns[0] && hasRowActions ? (
                      <RowActionsButton
                        row={row}
                        readOnly={readOnly}
                        actions={rowActions}
                        cell={contextCell(row)}
                        restoreFocus={
                          contextTarget?.rowId === String(row.id)
                            ? contextTarget.origin
                            : null
                        }
                        onContextTarget={setContextTarget}
                        onAddQuickFilter={onAddQuickFilter}
                        onCopyValue={onCopyValue}
                      />
                    ) : null}
                  </div>
                </Cell>
              );
            })}
          </Row>
        )}
      </TableBody>
    </Table>
  );

  const groups: GroupResult[] | null =
    output?.shape === "grouped" ? output.groups : null;
  // A row that is about to take focus must be on screen, so its group is
  // rendered open and the stored fold is dropped.
  const forcedOpenRowIds = [focusCreatedId, archiveFocus?.nextRowId].filter(
    (id): id is string => id !== undefined,
  );
  const forcedOpenGroup =
    forcedOpenRowIds.length === 0
      ? undefined
      : groups?.find((group) =>
          group.rows.some((row) => forcedOpenRowIds.includes(String(row.id))),
        );
  const forcedOpenIdentity =
    forcedOpenGroup === undefined
      ? undefined
      : groupIdentity(forcedOpenGroup.key);
  const collapsedGroups = groupCollapse.collapsed;
  const isGroupExpanded = (identity: string) =>
    identity === forcedOpenIdentity || !collapsedGroups.has(identity);
  const groupIdentities = (groups ?? []).map((group) =>
    groupIdentity(group.key),
  );
  const anyGroupExpanded = groupIdentities.some(isGroupExpanded);
  const anyGroupCollapsed = groupIdentities.some(
    (identity) => !isGroupExpanded(identity),
  );
  const expandGroup = groupCollapse.expand;
  useEffect(() => {
    if (
      forcedOpenIdentity !== undefined &&
      collapsedGroups.has(forcedOpenIdentity)
    ) {
      expandGroup(forcedOpenIdentity);
    }
  }, [collapsedGroups, expandGroup, forcedOpenIdentity]);
  const capStatus = (() => {
    // A compact view scrolls, so it reports how far it has read rather than
    // what a limit excluded.
    if (compact && rowWindow && output?.shape === "flat") {
      const { loaded, total, hasMore, cappedBy } = rowWindow;
      if (total === undefined || loaded >= total) return undefined;
      const seen = `Showing ${loaded} of ${total} rows`;
      if (rowWindow.isLoadingMore) return `${seen}; loading more…`;
      if (cappedBy === "author") {
        return `${seen}; this embed's limit stops here.`;
      }
      if (cappedBy === "ceiling") {
        return `${seen}; narrow the embed's filter to reach the rest.`;
      }
      return hasMore ? `${seen}; scroll for more.` : `${seen}.`;
    }
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
  const shouldRenderGrid = output !== undefined || (!viewError && !viewLoading);
  // An embed that renders a header over nothing looks broken; say it is empty.
  const emptyResult =
    !viewLoading &&
    !viewError &&
    (output?.shape === "flat"
      ? output.rows.length === 0
      : output?.shape === "grouped" && output.groups.length === 0);
  const approachEnd = useCallback(() => {
    if (!rowWindow?.hasMore || rowWindow.isLoadingMore) return;
    rowWindow.loadMore();
  }, [rowWindow]);

  const rowCount =
    output?.shape === "flat"
      ? output.total
      : output?.shape === "grouped"
        ? output.groups.reduce((n, g) => n + g.total, 0)
        : undefined;
  const rowCountLabel =
    rowCount === undefined
      ? undefined
      : `${rowCount.toLocaleString("en-US")} ${rowCount === 1 ? "row" : "rows"}`;
  const viewTabClass = (active: boolean) =>
    cn(
      "relative flex items-center px-0.5 text-[13.5px]",
      screen ? "h-11" : "h-8",
      active
        ? "font-medium text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:rounded-full after:bg-accent"
        : "text-mute hover:text-ink",
    );
  const viewsNav = (
    <nav aria-label="Views" className="flex flex-wrap items-stretch gap-x-5">
      {(definition.views ?? []).map((v) =>
        readOnly ? (
          <span
            key={v.name}
            className={viewTabClass(
              asciiCaseFold(v.name) === equivalentActiveView,
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
              viewTabClass(asciiCaseFold(v.name) === equivalentActiveView),
              "cursor-pointer",
              FOCUS_RING_NATIVE,
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
  );
  const collapseAll =
    groups && groups.length > 0 ? (
      <Button
        variant="ghost"
        size="sm"
        onPress={() =>
          anyGroupExpanded
            ? groupCollapse.collapseAll(groupIdentities)
            : groupCollapse.expandAll()
        }
      >
        {anyGroupExpanded ? "Collapse all" : "Expand all"}
      </Button>
    ) : null;
  const fieldsPopover =
    !readOnly && onHideColumn && onShowColumn ? (
      <FieldsPopover
        columns={columns}
        hidden={hiddenColumns}
        labelFor={displayLabelForColumn}
        onHideColumn={onHideColumn}
        onShowColumn={onShowColumn}
        onShowAll={onShowHiddenColumns ?? noop}
      />
    ) : null;
  const configureLink = !readOnly && configureSlug && (
    <Link
      to="/bases/$slug/edit"
      params={{ slug: configureSlug }}
      className={buttonStyles(
        "secondary",
        "sm",
        screen ? undefined : "ml-auto",
      )}
      aria-label={`Configure ${definition.name}`}
    >
      <Settings aria-hidden="true" className="h-3.5 w-3.5" />
      Configure
    </Link>
  );
  const addMemberButton = (variant: "primary" | "secondary") =>
    !readOnly ? (
      <>
        {/* Reset React Aria's press responder after an in-flight operation. */}
        <Button
          key={memberSaving ? "add-busy" : "add-ready"}
          variant={variant}
          size="sm"
          className={screen || configureSlug ? undefined : "ml-auto"}
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
    ) : null;
  const pickerColumns = columns.map(pickerColumn);

  return (
    <section
      ref={viewRootRef}
      aria-label={`${definition.name} table view`}
      tabIndex={-1}
      className="flex flex-col gap-3"
    >
      {screen ? (
        <>
          <header
            className={cn(
              "flex flex-wrap items-end gap-x-7 gap-y-4",
              dense ? "pt-7" : "pt-10",
            )}
          >
            <div className="flex flex-col gap-2">
              <span className="flex items-center gap-2.5">
                <Tick />
                <span className="font-serif text-[19px] italic text-mute">
                  Base
                </span>
              </span>
              <h1
                className={cn(
                  "font-serif leading-none tracking-[-0.015em] text-ink",
                  dense ? "text-[44px]" : "text-[52px]",
                )}
              >
                {definition.name}
              </h1>
            </div>
            {rowCountLabel ? (
              <span className="pb-1.5 text-[14px] text-mute">
                {rowCountLabel}
              </span>
            ) : null}
            <div className="flex-1" />
            <Switch isSelected={compactRows} onChange={setCompactRows}>
              Compact
            </Switch>
            {configureLink}
            {addMemberButton("primary")}
            {toolbarActions}
          </header>
          <div className="flex min-h-11 flex-wrap items-stretch gap-x-6 gap-y-2">
            {viewsNav}
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              {!readOnly ? (
                <>
                  <FilterPicker
                    columns={pickerColumns}
                    activeCount={overrides.quickFilters.length}
                    onAddQuickFilter={onAddQuickFilter ?? noop}
                  />
                  <SortPicker
                    columns={pickerColumns}
                    sort={sort?.[0] ?? view?.sort?.[0]}
                    overridden={sort !== undefined}
                    onSortChange={onSortChange}
                  />
                  <GroupPicker
                    columns={pickerColumns}
                    group={effectiveGroup}
                    savedGroup={view?.group_by ?? undefined}
                    overridden={overrides.group !== undefined}
                    onSetGroup={onSetGroup ?? noop}
                  />
                </>
              ) : null}
              {fieldsPopover}
              {collapseAll}
            </div>
          </div>
          <FooterControls>
            <span>{`bases/${definition.slug}.base.toml`}</span>
            {rowCountLabel ? (
              <>
                <span aria-hidden className="text-faint">
                  ·
                </span>
                <span>{rowCountLabel}</span>
              </>
            ) : null}
          </FooterControls>
        </>
      ) : (
        <div
          className={cn(
            "flex flex-wrap items-center",
            compact ? "gap-2 pb-1.5" : "gap-3 pb-2",
          )}
        >
          {compact ? (
            // An embed sits inside someone else's document: naming the Base is
            // still needed, claiming a heading level is not.
            <p className="truncate text-[13px] font-medium text-ink">
              {definition.name}
            </p>
          ) : (
            <h1 className="text-[15px] font-medium text-ink">
              {definition.name}
            </h1>
          )}
          {viewsNav}
          {collapseAll}
          {fieldsPopover}
          {configureLink}
          {addMemberButton("secondary")}
          {toolbarActions}
        </div>
      )}
      <ViewOverridesStrip
        sort={sort}
        overrides={overrides}
        labelFor={displayLabelForColumn}
        readOnly={readOnly}
        save={overridesSave}
        onSortChange={onSortChange}
        onRemoveQuickFilter={onRemoveQuickFilter ?? noop}
        onSetGroup={onSetGroup ?? noop}
        onShowHiddenColumns={onShowHiddenColumns ?? noop}
        onClear={onClearOverrides ?? noop}
        onSave={onSaveOverrides ?? noop}
        onReload={onReloadDefinition ?? noop}
      />
      {memberDraftOpen && onSaveMember && onCancelMember ? (
        <BaseMemberDraft
          fields={memberDraftFields}
          titleTemplate={memberTitleTemplate}
          projects={projects}
          isSaving={memberSaving}
          isSaveDisabled={memberCapability?.enabled !== true}
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
          className="rounded-xl bg-sink px-4 py-2.5 text-[13px] text-mute"
        >
          {memberNotice}
        </p>
      ) : null}

      {viewError ? (
        <p
          role="alert"
          className="rounded-xl bg-sink px-4 py-2.5 text-[13px] text-warn"
        >
          View failed: {viewError}
        </p>
      ) : null}
      {rowActionError ? (
        <p
          role="alert"
          className="rounded-xl bg-sink px-4 py-2.5 text-[13px] text-warn"
        >
          {rowActionError}
        </p>
      ) : null}
      {viewLoading ? (
        <p
          role="status"
          aria-label="View loading"
          className="px-1 py-2 text-[13px] text-mute"
        >
          Loading…
        </p>
      ) : null}
      {capStatus ? (
        <p
          role="status"
          aria-label={compact ? "Result window" : "Result limit"}
          className="rounded-xl bg-sink px-4 py-2.5 text-[13px] text-mute"
        >
          {capStatus}
        </p>
      ) : null}
      {compact && emptyResult ? (
        <p
          role="status"
          aria-label="Empty view"
          className="rounded-xl bg-sink px-4 py-2.5 text-[13px] text-mute"
        >
          No pages match this view.
        </p>
      ) : null}
      {shouldRenderGrid ? (
        <>
          <ScrollViewport
            enabled={compact}
            autofill={!anyGroupCollapsed}
            onApproachEnd={approachEnd}
          >
            {groups ? (
              <div className="flex flex-col gap-1">
                {groups.map((group, index) => {
                  const key =
                    group.key == null
                      ? "(empty)"
                      : formatCellValue(group.key as CellValue);
                  const cacheIdentity = `${evaluationIdentity}:group:${JSON.stringify(group.key)}`;
                  const identity = groupIdentity(group.key);
                  const expanded = isGroupExpanded(identity);
                  const panelId = `${groupPanelIdBase}-group-${index}`;
                  return (
                    <section key={cacheIdentity}>
                      <header
                        className={cn(
                          "flex flex-wrap items-center gap-3",
                          dense ? "pt-3 pb-1" : "pt-5 pb-1",
                        )}
                      >
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-expanded={expanded}
                          aria-controls={panelId}
                          onPress={() => groupCollapse.toggle(identity)}
                          className={cn(
                            "h-auto gap-2 px-1 py-0 font-serif font-normal italic text-ink",
                            dense ? "text-[18px]" : "text-[21px]",
                          )}
                        >
                          {expanded ? (
                            <ChevronDown
                              aria-hidden="true"
                              className="h-4 w-4 text-mute"
                            />
                          ) : (
                            <ChevronRight
                              aria-hidden="true"
                              className="h-4 w-4 text-mute"
                            />
                          )}
                          {key}
                        </Button>
                        <span className="text-[12.5px] text-mute tabular-nums">
                          {group.rows.length < group.total
                            ? `${group.rows.length} of ${group.total} rows`
                            : `${group.total} row${group.total === 1 ? "" : "s"}`}
                        </span>
                        <AggregateChips
                          values={group.aggregates}
                          definition={definition}
                          viewName={activeView}
                          rows={displayAggregateRows}
                        />
                      </header>
                      <div id={panelId}>
                        {expanded
                          ? grid(
                              group.rows,
                              `${definition.name} — ${key}`,
                              cacheIdentity,
                            )
                          : null}
                      </div>
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
            )}
          </ScrollViewport>
          {output?.shape === "flat" && (view?.aggregates?.length ?? 0) > 0 ? (
            // biome-ignore lint/a11y/useSemanticElements: this is a footer-style totals summary, not a form — a <fieldset> would misrepresent it as a form-control group, so <footer role="group"> keeps footer semantics while role="group" gives it a legitimately nameable ARIA role.
            <footer
              role="group"
              aria-label="Totals"
              className="mt-2 flex flex-wrap items-center gap-2"
            >
              <span className="text-[12.5px] text-mute">Totals</span>
              <AggregateChips
                values={output.aggregates}
                definition={definition}
                viewName={activeView}
                rows={displayAggregateRows}
              />
            </footer>
          ) : null}
        </>
      ) : null}
      {shouldRenderGrid && !readOnly && !memberDraftOpen && onAddMember ? (
        <Button
          variant="ghost"
          // The row reads as "+ Add member…"; its name stays plain for
          // assistive technology and matches the toolbar action.
          aria-label={`Add member to ${definition.name}`}
          className="w-full justify-start rounded-[10px] px-3 text-[13px] text-mute hover:text-ink"
          isDisabled={memberAddDisabled}
          aria-describedby={memberBlocker ? memberBlockerId : undefined}
          onPress={onAddMember}
        >
          + Add member…
        </Button>
      ) : null}
      {!readOnly && onArchiveRow ? (
        <ArchiveRowDialog
          row={archiveTarget}
          onCancel={() => setArchiveTarget(null)}
          onConfirm={async (target) => {
            const ids = rowsInOrder.map((candidate) => String(candidate.id));
            const index = ids.indexOf(String(target.id));
            const next = ids[index + 1] ?? ids[index - 1];
            await onArchiveRow(target);
            setArchiveFocus({
              removedRowId: String(target.id),
              nextRowId: next,
            });
            setArchiveTarget(null);
          }}
        />
      ) : null}
    </section>
  );
});

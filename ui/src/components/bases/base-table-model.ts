import type {
  BaseDetailResponse,
  BaseMemberCapability,
  BaseMemberDiagnostic,
  PropertyType,
  QueryOutput,
  QueryRow,
  SortKey,
} from "#/api/bases";
import type { CellValue } from "./cells/types";
import type { EmbedScrollCap } from "./embed-query";
import type {
  BaseMemberDraftField,
  BaseMemberDraftValue,
} from "./member-draft";
import type { OverridesSaveState } from "./useViewOverrides";
import type {
  GroupOverride,
  QuickFilter,
  ViewOverridesState,
} from "./view-overrides";

/** The saved view being shown, and how to switch or re-sort it. */
export interface BaseTableQuery {
  activeView: string;
  output: QueryOutput | undefined;
  /** When set without cached output, the grid is replaced by an error banner. */
  error: string | undefined;
  loading: boolean;
  sort: SortKey[] | undefined;
  onViewChange(name: string): void;
  onSortChange(sort: SortKey[] | undefined): void;
}

/** Adding a member: the draft, its save, and focus on the created row. */
export interface BaseTableMembers {
  capability: BaseMemberCapability | undefined;
  draftFields: BaseMemberDraftField[];
  titleTemplate: string | undefined;
  draftOpen: boolean;
  saving: boolean;
  diagnostics: BaseMemberDiagnostic[];
  error: string | undefined;
  notice: string | undefined;
  projects: string[];
  focusCreatedId: string | undefined;
  onAdd(): void;
  onSave(value: BaseMemberDraftValue): void;
  onCancel(): void;
  onEdit(): void;
  onCreatedRowFocused(createdId: string): void;
}

/** Request-time changes to the view, and saving them into the definition. */
export interface BaseTableOverrides {
  state: ViewOverridesState;
  save: OverridesSaveState;
  onAddQuickFilter(filter: QuickFilter): void;
  onRemoveQuickFilter(identity: string): void;
  onSetGroup(group: GroupOverride | undefined): void;
  onHideColumn(column: string): void;
  onShowColumn(column: string): void;
  onShowHiddenColumns(): void;
  /** The whole column order, hidden columns included, after a move. */
  onReorderColumns(order: string[]): void;
  onResetColumnOrder(): void;
  onClear(): void;
  onSave(): void;
  onReloadDefinition(): void;
}

/** What a row and its cells can do. */
export interface BaseTableRowActions {
  onOpenPage(path: string): void;
  onCommitCell(
    row: QueryRow,
    key: string,
    value: CellValue,
    hint?: PropertyType,
  ): void;
  onOpenPageInNewTab(path: string): void;
  onCopyWikilink(row: QueryRow): void;
  onCopyValue(value: CellValue): void;
  onDuplicateRow(row: QueryRow): void;
  /** Resolves once the page is archived; rejects with an Error whose message the dialog shows. */
  onArchiveRow(row: QueryRow): Promise<void>;
  error: string | undefined;
}

/** Windowed loading, for a compact view that scrolls in place. */
export interface BaseTableWindow {
  /** The authoritative row count, not the rows rendered. */
  total: number | undefined;
  loaded: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** Which bound ended the scroll short of the total, if either did. */
  cappedBy: EmbedScrollCap | undefined;
  loadMore(): void;
}

/** A Base table that cannot render yet. */
export type BaseTableStatus =
  | { status: "loading" }
  | { status: "missing"; slug: string };

/** The controller's table once the definition is ready: every group filled. */
export interface BaseTableReadyModel {
  status: "ready";
  definition: BaseDetailResponse;
  /** The Base the Configure link edits. */
  configureSlug: string;
  query: BaseTableQuery;
  rowActions: BaseTableRowActions;
  members: BaseTableMembers;
  overrides: BaseTableOverrides;
  window: BaseTableWindow | undefined;
}

/** What `useBaseTableController` returns. */
export type BaseTableModel = BaseTableStatus | BaseTableReadyModel;

/**
 * What `BaseTableView` renders. The controller's ready model is one; a
 * preview may leave out what it does not offer. No member or override group
 * means none of their controls, no menu actions means no row menu (opening
 * the page is what the title button already does), and no `configureSlug`
 * means no Configure link.
 */
export interface BaseTableViewReady {
  status: "ready";
  definition: BaseDetailResponse;
  readOnly?: boolean;
  configureSlug?: string;
  query: BaseTableQuery;
  rowActions: Pick<BaseTableRowActions, "onOpenPage" | "onCommitCell"> &
    Partial<BaseTableRowActions>;
  members?: Partial<BaseTableMembers>;
  overrides?: Partial<BaseTableOverrides>;
  window?: BaseTableWindow;
}

export type BaseTableViewModel = BaseTableStatus | BaseTableViewReady;

const ignore = () => {};

/** A table that shows one output and accepts no edits, as the definition
 * preview does. */
export function readOnlyModel({
  definition,
  activeView,
  output,
}: {
  definition: BaseDetailResponse;
  activeView: string;
  output: QueryOutput;
}): BaseTableViewReady {
  return {
    status: "ready",
    definition,
    readOnly: true,
    query: {
      activeView,
      output,
      error: undefined,
      loading: false,
      sort: undefined,
      onViewChange: ignore,
      onSortChange: ignore,
    },
    rowActions: { onOpenPage: ignore, onCommitCell: ignore },
  };
}

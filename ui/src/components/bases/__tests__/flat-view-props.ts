import type { ReactNode } from "react";
import type {
  BaseDetailResponse,
  BaseMemberCapability,
  BaseMemberDiagnostic,
  PropertyType,
  QueryOutput,
  QueryRow,
  SortKey,
} from "#/api/bases";
import type { BaseTableViewProps } from "#/components/bases/BaseTableView";
import type {
  BaseTableViewReady,
  BaseTableWindow,
} from "#/components/bases/base-table-model";
import type { CellValue } from "#/components/bases/cells/types";
import type {
  BaseMemberDraftField,
  BaseMemberDraftValue,
} from "#/components/bases/member-draft";
import type { OverridesSaveState } from "#/components/bases/useViewOverrides";
import type {
  GroupOverride,
  QuickFilter,
  ViewOverridesState,
} from "#/components/bases/view-overrides";

/**
 * A ready table's model and presentation written as one flat bag, so view
 * tests can set and override single inputs. `viewProps` groups them.
 */
export interface FlatViewProps {
  definition: BaseDetailResponse;
  activeView: string;
  onViewChange: (name: string) => void;
  output: QueryOutput | undefined;
  viewError?: string;
  viewLoading?: boolean;
  sort: SortKey[] | undefined;
  onSortChange: (sort: SortKey[] | undefined) => void;
  onOpenPage: (path: string) => void;
  configureSlug?: string;
  screen?: boolean;
  chrome?: "full" | "compact";
  toolbarActions?: ReactNode;
  rowWindow?: BaseTableWindow;
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
  onReorderColumns?(order: string[]): void;
  onResetColumnOrder?(): void;
  onClearOverrides?(): void;
  onSaveOverrides?(): void;
  onReloadDefinition?(): void;
  overridesSave?: OverridesSaveState;
  onOpenPageInNewTab?(path: string): void;
  onCopyWikilink?(row: QueryRow): void;
  onCopyValue?(value: CellValue): void;
  onDuplicateRow?(row: QueryRow): void;
  onArchiveRow?(row: QueryRow): Promise<void>;
  rowActionError?: string;
}

function readyModel(flat: FlatViewProps): BaseTableViewReady {
  return {
    status: "ready",
    definition: flat.definition,
    readOnly: flat.readOnly,
    configureSlug: flat.configureSlug,
    query: {
      activeView: flat.activeView,
      output: flat.output,
      error: flat.viewError,
      loading: flat.viewLoading ?? false,
      sort: flat.sort,
      onViewChange: flat.onViewChange,
      onSortChange: flat.onSortChange,
    },
    rowActions: {
      onOpenPage: flat.onOpenPage,
      onCommitCell: flat.onCommitCell,
      onOpenPageInNewTab: flat.onOpenPageInNewTab,
      onCopyWikilink: flat.onCopyWikilink,
      onCopyValue: flat.onCopyValue,
      onDuplicateRow: flat.onDuplicateRow,
      onArchiveRow: flat.onArchiveRow,
      error: flat.rowActionError,
    },
    members: {
      capability: flat.memberCapability,
      draftFields: flat.memberDraftFields,
      titleTemplate: flat.memberTitleTemplate,
      draftOpen: flat.memberDraftOpen,
      saving: flat.memberSaving,
      diagnostics: flat.memberDiagnostics,
      error: flat.memberError,
      notice: flat.memberNotice,
      projects: flat.projects,
      focusCreatedId: flat.focusCreatedId,
      onAdd: flat.onAddMember,
      onSave: flat.onSaveMember,
      onCancel: flat.onCancelMember,
      onEdit: flat.onMemberEdit,
      onCreatedRowFocused: flat.onCreatedRowFocused,
    },
    overrides: {
      state: flat.overrides,
      save: flat.overridesSave,
      onAddQuickFilter: flat.onAddQuickFilter,
      onRemoveQuickFilter: flat.onRemoveQuickFilter,
      onSetGroup: flat.onSetGroup,
      onHideColumn: flat.onHideColumn,
      onShowColumn: flat.onShowColumn,
      onShowHiddenColumns: flat.onShowHiddenColumns,
      onReorderColumns: flat.onReorderColumns,
      onResetColumnOrder: flat.onResetColumnOrder,
      onClear: flat.onClearOverrides,
      onSave: flat.onSaveOverrides,
      onReloadDefinition: flat.onReloadDefinition,
    },
    window: flat.rowWindow,
  };
}

export function viewProps(flat: FlatViewProps): BaseTableViewProps {
  return {
    model: readyModel(flat),
    screen: flat.screen,
    chrome: flat.chrome,
    toolbarActions: flat.toolbarActions,
  };
}

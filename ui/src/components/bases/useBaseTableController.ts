import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type BaseDetailResponse,
  type BaseFilter,
  type BaseMemberCapability,
  type BaseMemberDiagnostic,
  type BaseViewEvaluateResponse,
  type PropertyType,
  type QueryOutput,
  type QueryRow,
  type SortKey,
  useBase,
  useBaseView,
  useBaseViewWindows,
  useCreateBaseMember,
  usePropertyCommit,
  useUpdateBase,
  type ViewOverrides,
} from "#/api/bases";
import { formatApiError, isApiConflict } from "#/api/error";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useProjects } from "#/lib/useProjects";
import type { CellValue } from "./cells/types";
import {
  type BaseEmbedConfig,
  type EmbedScrollCap,
  predicateIdentity,
  queryIdentity,
} from "./embed-query";
import { asciiCaseFold } from "./local-validation";
import {
  type MemberCreationOutcome,
  type MemberCreationSource,
  resolveMemberCreationSession,
} from "./member-creation";
import {
  type BaseMemberDraftField,
  type BaseMemberDraftValue,
  composeMemberDraftFields,
} from "./member-draft";
import { type OverridesSaveState, useViewOverrides } from "./useViewOverrides";
import {
  applyOverridesToView,
  composeQuickFilters,
  definitionPayload,
  type GroupOverride,
  type QuickFilter,
  type ViewOverridesState,
} from "./view-overrides";

export interface BaseTableControllerOptions {
  mode: "standalone" | "embedded";
  slug: string;
  activeView: string;
  sort: SortKey[] | undefined;
  filter?: BaseFilter;
  limit?: number;
  onViewChange(view: string): void;
  onSortChange(sort: SortKey[] | undefined): void;
}

export interface BaseTableControllerModel {
  definition: BaseDetailResponse | undefined;
  detailLoading: boolean;
  detailMissing: boolean;
  activeView: string;
  output: QueryOutput | undefined;
  viewError: string | undefined;
  viewLoading: boolean;
  sort: SortKey[] | undefined;
  onViewChange(name: string): void;
  onSortChange(sort: SortKey[] | undefined): void;
  onOpenPage(path: string): void;
  configureSlug: string | undefined;
  onCommitCell(
    row: QueryRow,
    key: string,
    value: CellValue,
    hint?: PropertyType,
  ): void;
  memberCapability: BaseMemberCapability | undefined;
  memberDraftFields: BaseMemberDraftField[];
  memberTitleTemplate: string | undefined;
  memberDraftOpen: boolean;
  memberSaving: boolean;
  memberDiagnostics: BaseMemberDiagnostic[];
  memberError: string | undefined;
  memberNotice: string | undefined;
  projects: string[];
  onAddMember(): void;
  onSaveMember(value: BaseMemberDraftValue): void;
  onCancelMember(): void;
  onMemberEdit(): void;
  focusCreatedId: string | undefined;
  onCreatedRowFocused(createdId: string): void;
  overrides: ViewOverridesState;
  onAddQuickFilter(filter: QuickFilter): void;
  onRemoveQuickFilter(identity: string): void;
  onSetGroup(group: GroupOverride | undefined): void;
  onHideColumn(column: string): void;
  onShowHiddenColumns(): void;
  onClearOverrides(): void;
  onSaveOverrides(): void;
  onReloadDefinition(): void;
  overridesSave: OverridesSaveState;
  /** Windowed loading, for an embedded view that scrolls in place. */
  rowWindow:
    | {
        total: number | undefined;
        loaded: number;
        hasMore: boolean;
        isLoadingMore: boolean;
        cappedBy: EmbedScrollCap | undefined;
        loadMore(): void;
      }
    | undefined;
}

type PlacementIdentity =
  | { mode: "standalone" }
  | { mode: "embedded"; queryIdentity: string };

type MemberCreationLifecycle =
  | { phase: "idle" }
  | { phase: "submitting"; operation: number; view: string }
  | { phase: "refreshing"; operation: number; createdId: string; view: string }
  | {
      phase: "resolving";
      operation: number;
      createdId: string;
      view: string;
      placement: PlacementIdentity;
    };

type MemberNotice =
  | { scope: "generic"; message: string }
  | { scope: "query"; queryIdentity: string; message: string };

interface MemberState {
  generation: number;
  draftOpen: boolean;
  error: string | undefined;
  diagnostics: BaseMemberDiagnostic[];
  creation: MemberCreationLifecycle;
  notice: MemberNotice | undefined;
}

interface EmbeddedSuccess {
  predicate: string;
  query: string;
  data: BaseViewEvaluateResponse;
}

const IDLE_MEMBER_CREATION: MemberCreationLifecycle = { phase: "idle" };

function emptyMemberState(generation: number): MemberState {
  return {
    generation,
    draftOpen: false,
    error: undefined,
    diagnostics: [],
    creation: IDLE_MEMBER_CREATION,
    notice: undefined,
  };
}

function outputContains(output: QueryOutput, id: string): boolean {
  return output.shape === "flat"
    ? output.rows.some((row) => row.id === id)
    : output.groups.some((group) => group.rows.some((row) => row.id === id));
}

function genericNotice(message: string): MemberNotice {
  return { scope: "generic", message };
}

function placementNotice(
  message: string,
  placement: PlacementIdentity,
): MemberNotice {
  return placement.mode === "embedded"
    ? { scope: "query", queryIdentity: placement.queryIdentity, message }
    : genericNotice(message);
}

/** Shared orchestration for standalone and embedded Base tables. */
export function useBaseTableController(
  options: BaseTableControllerOptions,
): BaseTableControllerModel {
  const {
    mode,
    slug,
    activeView: requestedActiveView,
    sort,
    filter,
    limit,
    onViewChange: notifyViewChange,
    onSortChange: notifySortChange,
  } = options;
  const openTab = useOpenTab();
  const detail = useBase(slug);
  const activeView = requestedActiveView || detail.data?.views?.[0]?.name || "";
  const overrides = useViewOverrides(
    `${mode}:${slug}:${asciiCaseFold(activeView)}`,
  );
  const effectiveFilter = useMemo(
    () =>
      composeQuickFilters(
        mode === "embedded" ? filter : undefined,
        overrides.state.quickFilters,
      ),
    [filter, mode, overrides.state.quickFilters],
  );
  const sortOverride = useMemo<ViewOverrides>(() => {
    const first = sort?.[0];
    return first ? { sort: first.field, dir: first.dir } : {};
  }, [sort]);
  const embeddedConfig = useMemo<BaseEmbedConfig>(
    () => ({
      base: mode === "embedded" ? slug : "",
      view: mode === "embedded" ? activeView : "",
      filter: mode === "embedded" ? effectiveFilter : undefined,
      sort: mode === "embedded" ? sort : undefined,
      // The author's ceiling, when they set one. Absent means the reader may
      // scroll to the true total.
      limit: mode === "embedded" ? limit : undefined,
      ...(overrides.state.group === undefined
        ? {}
        : { groupBy: overrides.state.group }),
    }),
    [
      activeView,
      effectiveFilter,
      limit,
      mode,
      overrides.state.group,
      slug,
      sort,
    ],
  );
  const savedViewQuery = useBaseView(
    mode === "standalone" ? slug : "",
    mode === "standalone" ? activeView : undefined,
    mode === "standalone"
      ? {
          ...sortOverride,
          ...(effectiveFilter === undefined ? {} : { filter: effectiveFilter }),
          ...(overrides.state.group === undefined
            ? {}
            : { groupBy: overrides.state.group }),
        }
      : {},
  );
  const evaluationQuery = useBaseViewWindows(embeddedConfig);
  const commit = usePropertyCommit();
  const { mutateAsync: createMemberAsync } = useCreateBaseMember();
  const updateBase = useUpdateBase();
  const projects = useProjects();
  const detailRefetch = detail.refetch;
  const evaluationRefetch = evaluationQuery.refetch;
  const savedViewRefetch = savedViewQuery.refetch;

  const predicate =
    mode === "embedded"
      ? predicateIdentity(embeddedConfig)
      : JSON.stringify({ mode, slug });
  const embeddedQueryKey =
    mode === "embedded" ? queryIdentity(embeddedConfig) : "";
  const generationRef = useRef({ predicate, generation: 0 });
  const currentOperation = useRef<
    { generation: number; operation: number } | undefined
  >(undefined);
  const nextOperation = useRef(0);
  const mounted = useRef(true);
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const lastEmbeddedSuccess = useRef<EmbeddedSuccess | undefined>(undefined);
  const currentEmbeddedQuery = useRef({
    query: embeddedQueryKey,
    refetch: evaluationRefetch,
  });
  currentEmbeddedQuery.current = {
    query: embeddedQueryKey,
    refetch: evaluationRefetch,
  };

  if (generationRef.current.predicate !== predicate) {
    generationRef.current = {
      predicate,
      generation: generationRef.current.generation + 1,
    };
    currentOperation.current = undefined;
  }
  const generation = generationRef.current.generation;
  const [storedMemberState, setStoredMemberState] = useState<MemberState>(() =>
    emptyMemberState(generation),
  );
  const memberState =
    storedMemberState.generation === generation
      ? storedMemberState
      : emptyMemberState(generation);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      currentOperation.current = undefined;
    };
  }, []);

  if (mode === "embedded" && evaluationQuery.data) {
    lastEmbeddedSuccess.current = {
      predicate,
      query: embeddedQueryKey,
      data: evaluationQuery.data,
    };
  }
  const retainedEmbedded = lastEmbeddedSuccess.current;
  const exactEmbeddedSuccess =
    mode === "embedded" && retainedEmbedded?.query === embeddedQueryKey
      ? retainedEmbedded.data
      : undefined;
  const predicateEmbeddedSuccess =
    mode === "embedded" && retainedEmbedded?.predicate === predicate
      ? retainedEmbedded.data
      : undefined;
  const embeddedAuthoritative =
    mode === "embedded" &&
    evaluationQuery.data !== undefined &&
    !evaluationQuery.isLoading &&
    !evaluationQuery.isFetching &&
    !evaluationQuery.error;
  const output =
    mode === "standalone" ? savedViewQuery.data : exactEmbeddedSuccess?.output;

  const memberCreationSource = useMemo<MemberCreationSource | undefined>(() => {
    if (mode === "standalone") {
      return detail.data
        ? {
            kind: "definition",
            baseSlug: slug,
            requestedView: activeView,
            detail: detail.data,
          }
        : undefined;
    }
    return embeddedAuthoritative && evaluationQuery.data
      ? {
          kind: "evaluation",
          baseSlug: slug,
          requestedView: activeView,
          evaluation: evaluationQuery.data,
          embedFilter: effectiveFilter,
        }
      : undefined;
  }, [
    activeView,
    detail.data,
    detail.data?.revision,
    effectiveFilter,
    embeddedAuthoritative,
    evaluationQuery.data,
    evaluationQuery.data?.revision,
    mode,
    slug,
  ]);
  const memberCreationSession = useMemo(
    () =>
      memberCreationSource
        ? resolveMemberCreationSession(memberCreationSource)
        : undefined,
    [memberCreationSource],
  );
  const memberCapability = memberCreationSession?.capability;
  const retainedDraftCapability =
    memberCapability ??
    (memberState.draftOpen && mode === "embedded"
      ? predicateEmbeddedSuccess?.member_creation
      : undefined);
  const activeViewDefinition = useMemo(
    () =>
      detail.data?.views?.find(
        (candidate) =>
          asciiCaseFold(candidate.name) === asciiCaseFold(activeView),
      ),
    [activeView, detail.data?.views],
  );
  const baseColumns = useMemo(
    () =>
      activeViewDefinition?.columns && activeViewDefinition.columns.length > 0
        ? activeViewDefinition.columns
        : ["title"],
    [activeViewDefinition?.columns],
  );
  const [overridesSave, setOverridesSave] = useState<OverridesSaveState>({
    phase: "idle",
  });
  const overridesClear = overrides.clear;
  const clearOverrides = useCallback(() => {
    overridesClear();
    notifySortChange(undefined);
    setOverridesSave({ phase: "idle" });
  }, [notifySortChange, overridesClear]);
  const saveOverrides = useCallback(async () => {
    const current = detail.data;
    const view = activeViewDefinition;
    if (!current || !view) return;
    setOverridesSave({ phase: "saving" });
    const nextView = applyOverridesToView(
      view,
      overrides.state,
      sort,
      baseColumns,
    );
    try {
      await updateBase.mutateAsync({
        params: { path: { slug } },
        body: {
          expected_revision: current.revision,
          definition: definitionPayload(current, nextView),
          view_origins: (current.views ?? []).map((candidate) => ({
            kind: "existing" as const,
            name: candidate.name,
          })),
        },
      });
      overridesClear();
      notifySortChange(undefined);
      setOverridesSave({ phase: "idle" });
    } catch (error) {
      setOverridesSave(
        isApiConflict(error)
          ? {
              phase: "conflict",
              message: "This base changed elsewhere. Reload, then save again.",
            }
          : {
              phase: "error",
              message: formatApiError(error, "The view could not be saved."),
            },
      );
    }
  }, [
    activeViewDefinition,
    baseColumns,
    detail.data,
    notifySortChange,
    overrides.state,
    overridesClear,
    slug,
    sort,
    updateBase,
  ]);
  const reloadDefinition = useCallback(async () => {
    await detailRefetch();
    setOverridesSave({ phase: "idle" });
  }, [detailRefetch]);
  const memberDraftFields = useMemo(
    () =>
      detail.data && activeView && retainedDraftCapability
        ? composeMemberDraftFields(
            detail.data,
            activeView,
            retainedDraftCapability,
          )
        : [],
    [activeView, detail.data, retainedDraftCapability],
  );

  const operationIsCurrent = useCallback(
    (operation: number, operationGeneration: number) =>
      mounted.current &&
      generationRef.current.generation === operationGeneration &&
      currentOperation.current?.generation === operationGeneration &&
      currentOperation.current.operation === operation,
    [],
  );
  const refetchCurrentEmbeddedQuery = useCallback(
    async (operation: number, operationGeneration: number) => {
      while (operationIsCurrent(operation, operationGeneration)) {
        const target = currentEmbeddedQuery.current;
        const refreshed = await target.refetch();
        if (!operationIsCurrent(operation, operationGeneration))
          return undefined;
        if (currentEmbeddedQuery.current.query === target.query) {
          return {
            refreshed,
            placement: {
              mode: "embedded",
              queryIdentity: target.query,
            } as const,
          };
        }
      }
      return undefined;
    },
    [operationIsCurrent],
  );
  const finishMemberOperation = useCallback(
    (operation: number, operationGeneration: number, notice?: MemberNotice) => {
      if (!operationIsCurrent(operation, operationGeneration)) return;
      currentOperation.current = undefined;
      setStoredMemberState((current) =>
        current.generation === operationGeneration &&
        current.creation.phase !== "idle" &&
        current.creation.operation === operation
          ? { ...current, creation: IDLE_MEMBER_CREATION, notice }
          : current,
      );
    },
    [operationIsCurrent],
  );

  useEffect(() => {
    const creation = memberState.creation;
    if (creation.phase !== "resolving") return;
    if (
      creation.placement.mode === "embedded" &&
      (mode !== "embedded" ||
        creation.placement.queryIdentity !== embeddedQueryKey)
    ) {
      finishMemberOperation(creation.operation, generation);
      return;
    }
    if (
      mode === "standalone" &&
      asciiCaseFold(creation.view) !== asciiCaseFold(activeView)
    ) {
      finishMemberOperation(
        creation.operation,
        generation,
        genericNotice(
          "The member was created, but focus was skipped because the active view changed.",
        ),
      );
      return;
    }
    const loading =
      mode === "standalone"
        ? savedViewQuery.isFetching || savedViewQuery.isLoading
        : evaluationQuery.isFetching || evaluationQuery.isLoading;
    const error =
      mode === "standalone" ? savedViewQuery.error : evaluationQuery.error;
    if (loading || error || !output) return;
    if (!outputContains(output, creation.createdId)) {
      finishMemberOperation(
        creation.operation,
        generation,
        placementNotice(
          "The member was created, but it is not included in the current view.",
          creation.placement,
        ),
      );
      return;
    }
    const columns = activeViewDefinition?.columns;
    if (columns && columns.length > 0 && !columns.includes("title")) {
      finishMemberOperation(
        creation.operation,
        generation,
        genericNotice(
          "The member was created, but this view does not display its title.",
        ),
      );
    }
  }, [
    activeView,
    activeViewDefinition?.columns,
    embeddedQueryKey,
    evaluationQuery.error,
    evaluationQuery.isFetching,
    evaluationQuery.isLoading,
    finishMemberOperation,
    generation,
    memberState.creation,
    mode,
    output,
    savedViewQuery.error,
    savedViewQuery.isFetching,
    savedViewQuery.isLoading,
  ]);

  const createMember = useCallback(
    async (value: BaseMemberDraftValue) => {
      if (!memberCreationSession) return;

      const operation = nextOperation.current + 1;
      nextOperation.current = operation;
      const operationGeneration = generation;
      currentOperation.current = { generation: operationGeneration, operation };
      setStoredMemberState((current) => ({
        ...(current.generation === operationGeneration
          ? current
          : emptyMemberState(operationGeneration)),
        error: undefined,
        diagnostics: [],
        creation: { phase: "submitting", operation, view: activeView },
      }));

      const outcome: MemberCreationOutcome = await memberCreationSession.submit(
        value,
        {
          create: (baseSlug, body) =>
            createMemberAsync({
              params: { path: { slug: baseSlug } },
              body,
            }),
          refreshAfterConflict: async () => {
            if (mode === "embedded") {
              const refresh = await refetchCurrentEmbeddedQuery(
                operation,
                operationGeneration,
              );
              if (refresh?.refreshed.error) throw refresh.refreshed.error;
            } else {
              const refreshed = await detailRefetch();
              if (refreshed.error) throw refreshed.error;
            }
          },
        },
      );
      if (!operationIsCurrent(operation, operationGeneration)) return;
      if (outcome.kind !== "created") {
        setStoredMemberState((current) =>
          current.generation === operationGeneration
            ? {
                ...current,
                error: outcome.message,
                diagnostics: outcome.diagnostics,
              }
            : current,
        );
        finishMemberOperation(operation, operationGeneration);
        return;
      }
      const created = outcome.member;

      setStoredMemberState((current) =>
        current.generation === operationGeneration
          ? {
              ...current,
              draftOpen: false,
              notice: undefined,
              creation: {
                phase: "refreshing",
                operation,
                createdId: created.id,
                view: activeView,
              },
            }
          : current,
      );
      try {
        const refresh =
          mode === "embedded"
            ? await refetchCurrentEmbeddedQuery(operation, operationGeneration)
            : {
                refreshed: await savedViewRefetch(),
                placement: { mode: "standalone" } as const,
              };
        if (!refresh) return;
        const { refreshed, placement } = refresh;
        if (!operationIsCurrent(operation, operationGeneration)) return;
        if (
          mode === "standalone" &&
          asciiCaseFold(activeViewRef.current) !== asciiCaseFold(activeView)
        ) {
          finishMemberOperation(
            operation,
            operationGeneration,
            genericNotice(
              "The member was created, but focus was skipped because the active view changed.",
            ),
          );
          return;
        }
        if (refreshed.error) {
          finishMemberOperation(
            operation,
            operationGeneration,
            genericNotice(
              "The member was created, but the current view could not be refreshed.",
            ),
          );
          return;
        }
        const refreshedOutput =
          mode === "embedded"
            ? (refreshed.data as BaseViewEvaluateResponse | undefined)?.output
            : (refreshed.data as QueryOutput | undefined);
        if (refreshedOutput && !outputContains(refreshedOutput, created.id)) {
          finishMemberOperation(
            operation,
            operationGeneration,
            placementNotice(
              "The member was created, but it is not included in the current view.",
              placement,
            ),
          );
          return;
        }
        const columns = activeViewDefinition?.columns;
        if (columns && columns.length > 0 && !columns.includes("title")) {
          finishMemberOperation(
            operation,
            operationGeneration,
            genericNotice(
              "The member was created, but this view does not display its title.",
            ),
          );
          return;
        }
        setStoredMemberState((current) =>
          current.generation === operationGeneration
            ? {
                ...current,
                creation: {
                  phase: "resolving",
                  operation,
                  createdId: created.id,
                  view: activeView,
                  placement,
                },
              }
            : current,
        );
      } catch {
        finishMemberOperation(
          operation,
          operationGeneration,
          genericNotice(
            "The member was created, but the current view could not be refreshed.",
          ),
        );
      }
    },
    [
      activeView,
      activeViewDefinition?.columns,
      createMemberAsync,
      detailRefetch,
      finishMemberOperation,
      generation,
      memberCreationSession,
      mode,
      operationIsCurrent,
      refetchCurrentEmbeddedQuery,
      savedViewRefetch,
    ],
  );

  const handleViewChange = useCallback(
    (name: string) => {
      if (mode === "embedded") {
        currentOperation.current = undefined;
        setStoredMemberState(emptyMemberState(generation));
      } else {
        setStoredMemberState((current) => ({
          ...current,
          draftOpen: false,
          error: undefined,
          diagnostics: [],
          notice: undefined,
        }));
      }
      notifySortChange(undefined);
      notifyViewChange(name);
      setOverridesSave({ phase: "idle" });
    },
    [generation, mode, notifySortChange, notifyViewChange],
  );
  const handleSortChange = useCallback(
    (nextSort: SortKey[] | undefined) => {
      notifySortChange(nextSort);
    },
    [notifySortChange],
  );
  const handleAddMember = useCallback(() => {
    if (
      memberCapability?.enabled !== true ||
      memberState.creation.phase !== "idle" ||
      currentOperation.current !== undefined ||
      (mode === "embedded" && !embeddedAuthoritative)
    )
      return;
    setStoredMemberState({ ...emptyMemberState(generation), draftOpen: true });
  }, [
    embeddedAuthoritative,
    generation,
    memberCapability?.enabled,
    memberState.creation.phase,
    mode,
  ]);
  const handleCancelMember = useCallback(() => {
    setStoredMemberState((current) =>
      current.generation === generation
        ? { ...current, draftOpen: false, error: undefined, diagnostics: [] }
        : current,
    );
  }, [generation]);
  const handleMemberEdit = useCallback(() => {
    setStoredMemberState((current) =>
      current.generation === generation
        ? { ...current, error: undefined, diagnostics: [] }
        : current,
    );
  }, [generation]);
  const handleCreatedRowFocused = useCallback(
    (createdId: string) => {
      const creation = memberState.creation;
      if (creation.phase === "resolving" && creation.createdId === createdId) {
        finishMemberOperation(creation.operation, generation);
      }
    },
    [finishMemberOperation, generation, memberState.creation],
  );
  const handleOpenPage = useCallback(
    (path: string) => openTab("page", path),
    [openTab],
  );
  const handleCommitCell = useCallback(
    (row: QueryRow, key: string, value: CellValue, hint?: PropertyType) => {
      void commit(row, key, value, hint).catch(() => undefined);
    },
    [commit],
  );
  const handleSaveMember = useCallback(
    (value: BaseMemberDraftValue) => {
      void createMember(value);
    },
    [createMember],
  );

  const viewErrorValue =
    mode === "standalone" ? savedViewQuery.error : evaluationQuery.error;
  const viewErrorObject = viewErrorValue as
    | { error?: string }
    | null
    | undefined;
  const viewLoading =
    mode === "standalone"
      ? savedViewQuery.isLoading
      : evaluationQuery.isLoading && !exactEmbeddedSuccess;
  const creation = memberState.creation;
  const memberSaving =
    creation.phase !== "idle" ||
    (memberState.draftOpen && mode === "embedded" && !embeddedAuthoritative);

  const visibleMemberNotice =
    memberState.notice?.scope === "query"
      ? mode === "embedded" &&
        memberState.notice.queryIdentity === embeddedQueryKey
        ? memberState.notice.message
        : undefined
      : memberState.notice?.message;
  const focusCreatedId =
    creation.phase === "resolving" &&
    ((mode === "standalone" && creation.placement.mode === "standalone") ||
      (mode === "embedded" &&
        creation.placement.mode === "embedded" &&
        creation.placement.queryIdentity === embeddedQueryKey))
      ? creation.createdId
      : undefined;
  return {
    definition: detail.data,
    detailLoading: detail.isLoading,
    detailMissing: !!detail.error || !detail.data || !activeView,
    activeView,
    output,
    viewError: viewErrorValue
      ? (viewErrorObject?.error ?? "request failed")
      : undefined,
    viewLoading,
    sort,
    onViewChange: handleViewChange,
    onSortChange: handleSortChange,
    onOpenPage: handleOpenPage,
    configureSlug: mode === "standalone" ? slug : undefined,
    onCommitCell: handleCommitCell,
    memberCapability,
    memberDraftFields,
    memberTitleTemplate: detail.data?.title_template ?? undefined,
    memberDraftOpen: memberState.draftOpen,
    memberSaving,
    memberDiagnostics: memberState.diagnostics,
    memberError: memberState.error,
    memberNotice: visibleMemberNotice,
    projects,
    onAddMember: handleAddMember,
    onSaveMember: handleSaveMember,
    onCancelMember: handleCancelMember,
    onMemberEdit: handleMemberEdit,
    focusCreatedId,
    onCreatedRowFocused: handleCreatedRowFocused,
    overrides: overrides.state,
    onAddQuickFilter: overrides.addQuickFilter,
    onRemoveQuickFilter: overrides.removeQuickFilter,
    onSetGroup: overrides.setGroup,
    onHideColumn: overrides.hideColumn,
    onShowHiddenColumns: overrides.showHiddenColumns,
    onClearOverrides: clearOverrides,
    onSaveOverrides: () => void saveOverrides(),
    onReloadDefinition: () => void reloadDefinition(),
    overridesSave,
    rowWindow:
      mode === "embedded"
        ? {
            total: evaluationQuery.total,
            loaded: evaluationQuery.loaded,
            hasMore: evaluationQuery.hasMore,
            isLoadingMore: evaluationQuery.isLoadingMore,
            cappedBy: evaluationQuery.cappedBy,
            loadMore: evaluationQuery.loadMore,
          }
        : undefined,
  };
}

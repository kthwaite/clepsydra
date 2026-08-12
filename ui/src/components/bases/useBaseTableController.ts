import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeBaseMemberDiagnostics,
  useBase,
  useBaseView,
  useBaseViewEvaluation,
  useCreateBaseMember,
  usePropertyCommit,
  type BaseDetailResponse,
  type BaseFilter,
  type BaseMemberCapability,
  type BaseMemberDiagnostic,
  type BaseViewEvaluateResponse,
  type PropertyType,
  type QueryOutput,
  type QueryRow,
  type SortKey,
  type ViewOverrides,
} from "#/api/bases";
import { formatApiError, isApiError } from "#/api/error";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useProjects } from "#/lib/useProjects";
import type { CellValue } from "./cells/types";
import {
  EMBED_DEFAULT_LIMIT,
  predicateIdentity,
  queryIdentity,
  type BaseEmbedConfig,
} from "./embed-query";
import { asciiCaseFold } from "./local-validation";
import {
  composeMemberDraftFields,
  type BaseMemberDraftField,
  type BaseMemberDraftValue,
} from "./member-draft";

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
  onCommitCell(row: QueryRow, key: string, value: CellValue, hint?: PropertyType): void;
  memberCapability: BaseMemberCapability | undefined;
  memberDraftFields: BaseMemberDraftField[];
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

function isRevisionConflict(error: unknown): boolean {
  return (
    isApiError(error) &&
    error.status === 409 &&
    typeof error.detail === "object" &&
    error.detail !== null &&
    "code" in error.detail &&
    (error.detail.code === "base_revision_conflict" ||
      error.detail.code === "revision_conflict")
  );
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
  const sortOverride = useMemo<ViewOverrides>(() => {
    const first = sort?.[0];
    return first ? { sort: first.field, dir: first.dir } : {};
  }, [sort]);
  const embeddedConfig = useMemo<BaseEmbedConfig>(
    () => ({
      base: mode === "embedded" ? slug : "",
      view: mode === "embedded" ? activeView : "",
      filter: mode === "embedded" ? filter : undefined,
      sort: mode === "embedded" ? sort : undefined,
      limit: mode === "embedded" ? (limit ?? EMBED_DEFAULT_LIMIT) : EMBED_DEFAULT_LIMIT,
    }),
    [activeView, filter, limit, mode, slug, sort],
  );
  const savedViewQuery = useBaseView(
    mode === "standalone" ? slug : "",
    mode === "standalone" ? activeView : undefined,
    mode === "standalone" ? sortOverride : {},
  );
  const evaluationQuery = useBaseViewEvaluation(embeddedConfig);
  const commit = usePropertyCommit();
  const { mutateAsync: createMemberAsync } = useCreateBaseMember();
  const projects = useProjects();
  const detailRevision = detail.data?.revision;
  const detailRefetch = detail.refetch;
  const evaluationRevision = evaluationQuery.data?.revision;
  const evaluationRefetch = evaluationQuery.refetch;
  const savedViewRefetch = savedViewQuery.refetch;

  const predicate = mode === "embedded"
    ? predicateIdentity(embeddedConfig)
    : JSON.stringify({ mode, slug });
  const embeddedQueryKey = mode === "embedded" ? queryIdentity(embeddedConfig) : "";
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
  const memberState = storedMemberState.generation === generation
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
  const output = mode === "standalone" ? savedViewQuery.data : exactEmbeddedSuccess?.output;

  const memberCapability = useMemo(
    () => mode === "embedded"
      ? predicateEmbeddedSuccess?.member_creation
      : detail.data?.member_creation?.find(
          (candidate) => asciiCaseFold(candidate.view) === asciiCaseFold(activeView),
        ),
    [activeView, detail.data?.member_creation, mode, predicateEmbeddedSuccess],
  );
  const activeViewDefinition = useMemo(
    () => detail.data?.views?.find(
      (candidate) => asciiCaseFold(candidate.name) === asciiCaseFold(activeView),
    ),
    [activeView, detail.data?.views],
  );
  const memberDraftFields = useMemo(
    () => detail.data && activeView && memberCapability
      ? composeMemberDraftFields(detail.data, activeView, memberCapability)
      : [],
    [activeView, detail.data, memberCapability],
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
        if (!operationIsCurrent(operation, operationGeneration)) return undefined;
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
    (
      operation: number,
      operationGeneration: number,
      notice?: MemberNotice,
    ) => {
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
    const loading = mode === "standalone"
      ? savedViewQuery.isFetching || savedViewQuery.isLoading
      : evaluationQuery.isFetching || evaluationQuery.isLoading;
    const error = mode === "standalone" ? savedViewQuery.error : evaluationQuery.error;
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

  const createMember = useCallback(async (value: BaseMemberDraftValue) => {
    if (mode === "embedded" && !embeddedAuthoritative) return;
    const revision = mode === "embedded"
      ? evaluationRevision
      : detailRevision;
    if (!revision || !activeView) return;

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

    const requestFields: BaseMemberDraftValue["fields"] = {};
    for (const key in value.fields) {
      if (!Object.hasOwn(value.fields, key)) continue;
      const fieldValue = value.fields[key];
      if (fieldValue !== null) requestFields[key] = fieldValue;
    }

    let created;
    try {
      created = await createMemberAsync({
        params: { path: { slug } },
        body: {
          base_revision: revision,
          ...(mode === "embedded" ? { embed_filter: filter } : {}),
          view: activeView,
          title: value.title.trim(),
          fields: requestFields,
        },
      });
    } catch (error) {
      if (!operationIsCurrent(operation, operationGeneration)) return;
      setStoredMemberState((current) => current.generation === operationGeneration
        ? {
            ...current,
            error: formatApiError(error, "Member could not be created."),
            diagnostics: decodeBaseMemberDiagnostics(error),
          }
        : current,
      );
      if (isRevisionConflict(error)) {
        try {
          if (mode === "embedded") {
            await refetchCurrentEmbeddedQuery(operation, operationGeneration);
          } else {
            await detailRefetch();
          }
        } finally {
          finishMemberOperation(operation, operationGeneration);
        }
      } else {
        finishMemberOperation(operation, operationGeneration);
      }
      return;
    }

    if (!operationIsCurrent(operation, operationGeneration)) return;
    setStoredMemberState((current) => current.generation === operationGeneration
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
      const refresh = mode === "embedded"
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
      const refreshedOutput = mode === "embedded"
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
      setStoredMemberState((current) => current.generation === operationGeneration
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
  }, [
    activeView,
    activeViewDefinition?.columns,
    createMemberAsync,
    detailRefetch,
    detailRevision,
    embeddedAuthoritative,
    evaluationRevision,
    filter,
    finishMemberOperation,
    generation,
    mode,
    operationIsCurrent,
    refetchCurrentEmbeddedQuery,
    savedViewRefetch,
    slug,
  ]);

  const handleViewChange = useCallback((name: string) => {
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
  }, [generation, mode, notifySortChange, notifyViewChange]);
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
    ) return;
    setStoredMemberState({ ...emptyMemberState(generation), draftOpen: true });
  }, [embeddedAuthoritative, generation, memberCapability?.enabled, memberState.creation.phase, mode]);
  const handleCancelMember = useCallback(() => {
    setStoredMemberState((current) => current.generation === generation
      ? { ...current, draftOpen: false, error: undefined, diagnostics: [] }
      : current,
    );
  }, [generation]);
  const handleMemberEdit = useCallback(() => {
    setStoredMemberState((current) => current.generation === generation
      ? { ...current, error: undefined, diagnostics: [] }
      : current,
    );
  }, [generation]);
  const handleCreatedRowFocused = useCallback((createdId: string) => {
    const creation = memberState.creation;
    if (creation.phase === "resolving" && creation.createdId === createdId) {
      finishMemberOperation(creation.operation, generation);
    }
  }, [finishMemberOperation, generation, memberState.creation]);
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

  const viewErrorValue = mode === "standalone" ? savedViewQuery.error : evaluationQuery.error;
  const viewErrorObject = viewErrorValue as { error?: string } | null | undefined;
  const viewLoading = mode === "standalone"
    ? savedViewQuery.isLoading
    : evaluationQuery.isLoading && !exactEmbeddedSuccess;
  const creation = memberState.creation;
  const memberSaving = creation.phase !== "idle" ||
    (memberState.draftOpen && mode === "embedded" && !embeddedAuthoritative);

  const visibleMemberNotice = memberState.notice?.scope === "query"
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
    viewError: viewErrorValue ? (viewErrorObject?.error ?? "request failed") : undefined,
    viewLoading,
    sort,
    onViewChange: handleViewChange,
    onSortChange: handleSortChange,
    onOpenPage: handleOpenPage,
    configureSlug: mode === "standalone" ? slug : undefined,
    onCommitCell: handleCommitCell,
    memberCapability,
    memberDraftFields,
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
  };
}

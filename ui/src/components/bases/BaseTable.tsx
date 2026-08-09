import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  decodeBaseMemberDiagnostics,
  useBase,
  useBaseView,
  useCreateBaseMember,
  usePropertyCommit,
  type BaseMemberDiagnostic,
  type ViewOverrides,
} from "#/api/bases";
import { formatApiError, isApiError } from "#/api/error";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useProjects } from "#/lib/useProjects";
import { BaseTableView } from "./BaseTableView";
import { asciiCaseFold } from "./local-validation";
import {
  composeMemberDraftFields,
  type BaseMemberDraftValue,
} from "./member-draft";

interface BaseTableProps {
  slug: string;
}

type MemberCreationLifecycle =
  | { phase: "idle" }
  | { phase: "submitting"; operation: number; view: string }
  | { phase: "refreshing"; operation: number; createdId: string; view: string }
  | { phase: "resolving"; operation: number; createdId: string; view: string };

const IDLE_MEMBER_CREATION: MemberCreationLifecycle = { phase: "idle" };

/** Data wiring for {@link BaseTableView}: queries, cell commits, navigation. */
export function BaseTable({ slug }: BaseTableProps) {
  const openTab = useOpenTab();
  const detail = useBase(slug);
  const [viewName, setViewName] = useState<string | undefined>(undefined);
  const [sortOverride, setSortOverride] = useState<ViewOverrides>({});
  const [memberDraftOpen, setMemberDraftOpen] = useState(false);
  const [memberError, setMemberError] = useState<string>();
  const [memberDiagnostics, setMemberDiagnostics] = useState<
    BaseMemberDiagnostic[]
  >([]);
  const [memberCreation, setMemberCreation] = useState<MemberCreationLifecycle>(
    IDLE_MEMBER_CREATION,
  );
  const [memberNotice, setMemberNotice] = useState<string>();
  const currentMemberOperation = useRef<number | undefined>(undefined);
  const nextMemberOperation = useRef(0);

  const activeView = viewName ?? detail.data?.views?.[0]?.name;
  const viewQuery = useBaseView(slug, activeView, sortOverride);
  const commit = usePropertyCommit();
  const activeViewRef = useRef(activeView);
  activeViewRef.current = activeView;
  const createMemberMutation = useCreateBaseMember();
  const projects = useProjects();
  const activeViewDefinition = useMemo(
    () =>
      detail.data?.views?.find(
        (candidate) =>
          asciiCaseFold(candidate.name) === asciiCaseFold(activeView ?? ""),
      ),
    [activeView, detail.data?.views],
  );
  const memberCapability = useMemo(
    () =>
      detail.data?.member_creation?.find(
        (candidate) =>
          asciiCaseFold(candidate.view) === asciiCaseFold(activeView ?? ""),
      ),
    [activeView, detail.data?.member_creation],
  );
  const memberDraftFields = useMemo(
    () =>
      detail.data && activeView && memberCapability
        ? composeMemberDraftFields(detail.data, activeView, memberCapability)
        : [],
    [activeView, detail.data, memberCapability],
  );

  const finishMemberOperation = useCallback(
    (operation: number, notice?: string) => {
      if (currentMemberOperation.current !== operation) return;
      currentMemberOperation.current = undefined;
      setMemberCreation((current) =>
        current.phase !== "idle" && current.operation === operation
          ? IDLE_MEMBER_CREATION
          : current,
      );
      setMemberNotice(notice);
    },
    [],
  );

  useEffect(() => {
    if (memberCreation.phase !== "resolving") return;
    if (
      asciiCaseFold(memberCreation.view) !== asciiCaseFold(activeView ?? "")
    ) {
      finishMemberOperation(
        memberCreation.operation,
        "The member was created, but focus was skipped because the active view changed.",
      );
      return;
    }
    if (
      viewQuery.isFetching ||
      viewQuery.isLoading ||
      viewQuery.error ||
      !viewQuery.data
    ) {
      return;
    }
    const createdIsPresent =
      viewQuery.data.shape === "flat"
        ? viewQuery.data.rows.some(
            (row) => row.id === memberCreation.createdId,
          )
        : viewQuery.data.groups.some((group) =>
            group.rows.some((row) => row.id === memberCreation.createdId),
          );
    if (!createdIsPresent) {
      finishMemberOperation(
        memberCreation.operation,
        "The member was created, but it is not included in the current view.",
      );
      return;
    }
    const columns = activeViewDefinition?.columns;
    if (columns && columns.length > 0 && !columns.includes("title")) {
      finishMemberOperation(
        memberCreation.operation,
        "The member was created, but this view does not display its title.",
      );
    }
  }, [
    activeView,
    activeViewDefinition?.columns,
    finishMemberOperation,
    memberCreation,
    viewQuery.data,
    viewQuery.error,
    viewQuery.isFetching,
    viewQuery.isLoading,
  ]);

  const handleCreatedRowFocused = useCallback(
    (createdId: string) => {
      if (
        memberCreation.phase === "resolving" &&
        memberCreation.createdId === createdId
      ) {
        finishMemberOperation(memberCreation.operation);
      }
    },
    [finishMemberOperation, memberCreation],
  );

  async function createMember(value: BaseMemberDraftValue) {
    const operation = nextMemberOperation.current + 1;
    nextMemberOperation.current = operation;
    currentMemberOperation.current = operation;
    const operationView = activeView!;
    setMemberCreation({
      phase: "submitting",
      operation,
      view: operationView,
    });
    setMemberError(undefined);
    setMemberDiagnostics([]);
    const requestFields: BaseMemberDraftValue["fields"] = {};
    for (const key in value.fields) {
      if (!Object.hasOwn(value.fields, key)) continue;
      const fieldValue = value.fields[key];
      if (fieldValue !== null) requestFields[key] = fieldValue;
    }
    let created;
    try {
      created = await createMemberMutation.mutateAsync({
        params: { path: { slug } },
        body: {
          base_revision: detail.data!.revision,
          view: operationView,
          title: value.title.trim(),
          fields: requestFields,
        },
      });
    } catch (error) {
      if (currentMemberOperation.current !== operation) return;
      setMemberError(formatApiError(error, "Member could not be created."));
      setMemberDiagnostics(decodeBaseMemberDiagnostics(error));
      const isRevisionConflict =
        isApiError(error) &&
        error.status === 409 &&
        typeof error.detail === "object" &&
        error.detail !== null &&
        "code" in error.detail &&
        error.detail.code === "base_revision_conflict";
      if (isRevisionConflict) {
        try {
          await detail.refetch();
        } finally {
          finishMemberOperation(operation);
        }
      } else {
        finishMemberOperation(operation);
      }
      return;
    }

    if (currentMemberOperation.current !== operation) return;
    setMemberDraftOpen(false);
    setMemberCreation({
      phase: "refreshing",
      operation,
      createdId: created.id,
      view: operationView,
    });
    setMemberNotice(undefined);
    try {
      const refreshed = await viewQuery.refetch();
      if (currentMemberOperation.current !== operation) return;
      if (refreshed.error) {
        finishMemberOperation(
          operation,
          "The member was created, but the current view could not be refreshed.",
        );
        return;
      }
      if (
        asciiCaseFold(activeViewRef.current ?? "") !==
        asciiCaseFold(operationView)
      ) {
        finishMemberOperation(
          operation,
          "The member was created, but focus was skipped because the active view changed.",
        );
        return;
      }
      setMemberCreation({
        phase: "resolving",
        operation,
        createdId: created.id,
        view: operationView,
      });
    } catch {
      finishMemberOperation(
        operation,
        "The member was created, but the current view could not be refreshed.",
      );
    }
  }

  if (detail.isLoading) {
    return <p className="cl-mono p-4 text-[12px] text-ink-mute">Loading…</p>;
  }
  if (detail.error || !detail.data || !activeView) {
    return (
      <p className="cl-mono p-4 text-[12px] text-ink-mute">
        No base named “{slug}” (or it declares no views).
      </p>
    );
  }

  // The view endpoint's typed error channel is `never`, so failures arrive
  // untyped; surface the ApiError body's message when present.
  const viewError = viewQuery.error as unknown as { error?: string } | null;

  return (
    <BaseTableView
      definition={detail.data}
      activeView={activeView}
      onViewChange={(name) => {
        setViewName(name);
        setSortOverride({});
        setMemberDraftOpen(false);
        setMemberError(undefined);
        setMemberDiagnostics([]);
        setMemberNotice(undefined);
      }}
      output={viewQuery.data}
      viewError={viewError ? (viewError.error ?? "request failed") : undefined}
      viewLoading={viewQuery.isLoading}
      sortOverride={sortOverride}
      onSortChange={setSortOverride}
      onOpenPage={(path) => openTab("page", path)}
      configureSlug={slug}
      memberCapability={memberCapability}
      memberDraftFields={memberDraftFields}
      memberDraftOpen={memberDraftOpen}
      memberSaving={memberCreation.phase !== "idle"}
      memberDiagnostics={memberDiagnostics}
      memberError={memberError}
      memberNotice={memberNotice}
      projects={projects}
      onAddMember={() => {
        if (
          memberCapability?.enabled !== true ||
          memberCreation.phase !== "idle" ||
          currentMemberOperation.current !== undefined
        ) {
          return;
        }
        setMemberError(undefined);
        setMemberDiagnostics([]);
        setMemberNotice(undefined);
        setMemberDraftOpen(true);
      }}
      onSaveMember={(value) => {
        void createMember(value);
      }}
      onCancelMember={() => {
        setMemberDraftOpen(false);
        setMemberError(undefined);
        setMemberDiagnostics([]);
      }}
      onMemberEdit={() => {
        setMemberError(undefined);
        setMemberDiagnostics([]);
      }}
      focusCreatedId={
        memberCreation.phase === "resolving" &&
        asciiCaseFold(memberCreation.view) === asciiCaseFold(activeView)
          ? memberCreation.createdId
          : undefined
      }
      onCreatedRowFocused={handleCreatedRowFocused}
      onCommitCell={(row, key, value, hint) => {
        void commit(row, key, value, hint);
      }}
    />
  );
}

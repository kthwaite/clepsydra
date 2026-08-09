import { useCallback, useEffect, useMemo, useState } from "react";
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
  | { phase: "submitting" }
  | { phase: "refreshing"; createdId: string }
  | { phase: "resolving"; createdId: string };

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

  const activeView = viewName ?? detail.data?.views?.[0]?.name;
  const viewQuery = useBaseView(slug, activeView, sortOverride);
  const commit = usePropertyCommit();
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

  useEffect(() => {
    if (
      memberCreation.phase !== "resolving" ||
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
      setMemberCreation(IDLE_MEMBER_CREATION);
      setMemberNotice(
        "The member was created, but it is not included in the current view.",
      );
      return;
    }
    const columns = activeViewDefinition?.columns;
    if (columns && columns.length > 0 && !columns.includes("title")) {
      setMemberCreation(IDLE_MEMBER_CREATION);
      setMemberNotice(
        "The member was created, but this view does not display its title.",
      );
    }
  }, [
    activeViewDefinition?.columns,
    memberCreation,
    viewQuery.data,
    viewQuery.error,
    viewQuery.isFetching,
    viewQuery.isLoading,
  ]);

  const handleCreatedRowFocused = useCallback(() => {
    setMemberCreation((current) =>
      current.phase === "resolving" ? IDLE_MEMBER_CREATION : current,
    );
    setMemberNotice(undefined);
  }, []);

  async function createMember(value: BaseMemberDraftValue) {
    setMemberCreation({ phase: "submitting" });
    setMemberError(undefined);
    setMemberDiagnostics([]);
    let created;
    try {
      created = await createMemberMutation.mutateAsync({
        params: { path: { slug } },
        body: {
          base_revision: detail.data!.revision,
          view: activeView!,
          title: value.title.trim(),
          fields: value.fields,
        },
      });
    } catch (error) {
      setMemberError(formatApiError(error, "Member could not be created."));
      setMemberDiagnostics(decodeBaseMemberDiagnostics(error));
      if (
        isApiError(error) &&
        error.status === 409 &&
        error.error === "base_revision_conflict"
      ) {
        try {
          await detail.refetch();
        } finally {
          setMemberCreation(IDLE_MEMBER_CREATION);
        }
      } else {
        setMemberCreation(IDLE_MEMBER_CREATION);
      }
      return;
    }

    setMemberDraftOpen(false);
    setMemberCreation({ phase: "refreshing", createdId: created.id });
    setMemberNotice(undefined);
    try {
      const refreshed = await viewQuery.refetch();
      if (refreshed.error) {
        setMemberCreation(IDLE_MEMBER_CREATION);
        setMemberNotice(
          "The member was created, but the current view could not be refreshed.",
        );
        return;
      }
      setMemberCreation({ phase: "resolving", createdId: created.id });
    } catch {
      setMemberCreation(IDLE_MEMBER_CREATION);
      setMemberNotice(
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
        setMemberCreation(IDLE_MEMBER_CREATION);
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
          memberCreation.phase !== "idle"
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
        setMemberCreation(IDLE_MEMBER_CREATION);
      }}
      onMemberEdit={() => {
        setMemberError(undefined);
        setMemberDiagnostics([]);
      }}
      focusCreatedId={
        memberCreation.phase === "resolving"
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

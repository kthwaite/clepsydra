import { useEffect, useMemo, useRef, useState } from "react";
import {
  type BaseMemberDiagnostic,
  useBase,
  useCreateBaseMember,
} from "#/api/bases";
import { Select, SelectItem } from "#/components/ui/select";
import { useProjects } from "#/lib/useProjects";
import { BaseMemberDraft } from "./BaseMemberDraft";
import { resolveMemberCreationSession } from "./member-creation";
import {
  type BaseMemberDraftField,
  type BaseMemberDraftValue,
  composeMemberDraftFields,
} from "./member-draft";

interface BaseMemberIntakeProps {
  slug: string;
  onCreated(path: string, title: string): void;
}

/** Base-member creation away from a Base table — the global intake flow — over
 * the same composed draft and the same authoritative endpoint the table uses,
 * so no entry point can drift into its own idea of a member. */
export function BaseMemberIntake({ slug, onCreated }: BaseMemberIntakeProps) {
  const detail = useBase(slug);
  const createMember = useCreateBaseMember();
  const projects = useProjects();
  const [selection, setSelection] = useState<{
    slug: string;
    view: string;
  }>();
  const [error, setError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<BaseMemberDiagnostic[]>([]);
  const submitInFlightRef = useRef(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const definition = detail.data;
  const views = definition?.views ?? [];
  const selectedView =
    selection?.slug === slug &&
    views.some((candidate) => candidate.name === selection.view)
      ? selection.view
      : undefined;
  const activeView = selectedView ?? views[0]?.name;
  const session = useMemo(
    () =>
      definition && activeView
        ? resolveMemberCreationSession({
            kind: "definition",
            baseSlug: slug,
            requestedView: activeView,
            detail: definition,
          })
        : undefined,
    [activeView, definition, slug],
  );
  const capability = session?.capability;
  const composedFields = useMemo(
    () =>
      definition && activeView && capability
        ? composeMemberDraftFields(definition, activeView, capability)
        : [],
    [activeView, capability, definition],
  );
  const [retainedDraftFields, setRetainedDraftFields] = useState<{
    slug: string;
    view: string;
    fields: BaseMemberDraftField[];
  }>();
  const sessionEnabled = capability?.enabled === true;
  useEffect(() => {
    if (!sessionEnabled || !activeView) return;
    setRetainedDraftFields({
      slug,
      view: activeView,
      fields: composedFields,
    });
  }, [activeView, composedFields, sessionEnabled, slug]);
  const retainedFieldsMatch =
    retainedDraftFields?.slug === slug &&
    retainedDraftFields.view === activeView;
  const fields = sessionEnabled
    ? composedFields
    : retainedFieldsMatch
      ? retainedDraftFields.fields
      : [];

  if (detail.isLoading) {
    return (
      <p role="status" className="cl-mono text-[11px] text-ink-mute">
        Loading Base…
      </p>
    );
  }
  if (!definition || !activeView) {
    return (
      <p role="alert" className="cl-mono text-[11px] text-hot">
        No Base named “{slug}” is available.
      </p>
    );
  }

  const blocker = sessionEnabled
    ? undefined
    : (capability?.blockers[0]?.message ??
      "Member creation is unavailable for this view.");

  async function save(value: BaseMemberDraftValue) {
    if (
      !session ||
      !sessionEnabled ||
      createMember.isPending ||
      submitInFlightRef.current
    ) {
      return;
    }
    submitInFlightRef.current = true;
    setIsSubmitting(true);
    setError(undefined);
    setDiagnostics([]);
    try {
      const outcome = await session.submit(value, {
        create: (baseSlug, request) =>
          createMember.mutateAsync({
            params: { path: { slug: baseSlug } },
            body: request,
          }),
        refreshAfterConflict: async () => {
          const refreshed = await detail.refetch();
          if (refreshed.error) throw refreshed.error;
        },
      });
      if (outcome.kind === "created") {
        onCreated(outcome.member.path, outcome.member.title);
        return;
      }
      setError(outcome.message);
      setDiagnostics(outcome.diagnostics);
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  }

  return (
    <div className="grid gap-2">
      {views.length > 1 ? (
        <Select
          label="View"
          value={activeView}
          onChange={(key) => {
            if (key == null) return;
            setSelection({ slug, view: String(key) });
            setDiagnostics([]);
            setError(undefined);
          }}
        >
          {views.map((candidate) => (
            <SelectItem key={candidate.name} id={candidate.name}>
              {candidate.name}
            </SelectItem>
          ))}
        </Select>
      ) : null}
      {blocker ? (
        <p role="alert" className="cl-mono text-[11px] text-hot">
          {blocker}
        </p>
      ) : null}
      {fields.length > 0 ? (
        <BaseMemberDraft
          fields={fields}
          titleTemplate={definition.title_template ?? undefined}
          projects={projects}
          isSaving={createMember.isPending}
          isSaveDisabled={!sessionEnabled || isSubmitting}
          diagnostics={diagnostics}
          summaryError={error}
          onSave={save}
          onCancel={() => {
            setError(undefined);
            setDiagnostics([]);
          }}
        />
      ) : null}
    </div>
  );
}

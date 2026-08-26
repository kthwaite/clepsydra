import { useMemo, useState } from "react";
import {
  type BaseMemberDiagnostic,
  useBase,
  useCreateBaseMember,
} from "#/api/bases";
import { Select, SelectItem } from "#/components/ui/select";
import { useProjects } from "#/lib/useProjects";
import { BaseMemberDraft } from "./BaseMemberDraft";
import {
  type BaseMemberDraftValue,
  composeMemberDraftFields,
} from "./member-draft";
import { resolveMemberCreationSession } from "./member-creation";

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
  const [view, setView] = useState<string>();
  const [error, setError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<BaseMemberDiagnostic[]>([]);

  const definition = detail.data;
  const views = definition?.views ?? [];
  const session = useMemo(
    () =>
      definition
        ? resolveMemberCreationSession({
            kind: "definition",
            baseSlug: slug,
            requestedView: view ?? "",
            detail: definition,
          })
        : undefined,
    [definition, slug, view],
  );
  const activeView = session?.view;
  const capability = session?.capability;
  const fields = useMemo(
    () =>
      definition && activeView && capability
        ? composeMemberDraftFields(definition, activeView, capability)
        : [],
    [definition, activeView, capability],
  );

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

  const blocker = capability?.enabled === false ? capability.blockers[0] : null;

  async function save(value: BaseMemberDraftValue) {
    if (!session) return;
    setError(undefined);
    setDiagnostics([]);
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
  }

  return (
    <div className="grid gap-2">
      {views.length > 1 ? (
        <Select
          label="View"
          value={activeView}
          onChange={(key) => {
            if (key == null) return;
            setView(String(key));
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
          {blocker.message}
        </p>
      ) : (
        <BaseMemberDraft
          fields={fields}
          titleTemplate={definition.title_template ?? undefined}
          projects={projects}
          isSaving={createMember.isPending}
          diagnostics={diagnostics}
          summaryError={error}
          onSave={save}
          onCancel={() => {
            setError(undefined);
            setDiagnostics([]);
          }}
        />
      )}
    </div>
  );
}

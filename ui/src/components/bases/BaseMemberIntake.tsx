import { useMemo, useState } from "react";
import {
  type BaseMemberDiagnostic,
  decodeBaseMemberDiagnostics,
  useBase,
  useCreateBaseMember,
} from "#/api/bases";
import { formatApiError } from "#/api/error";
import { Select, SelectItem } from "#/components/ui/select";
import { useProjects } from "#/lib/useProjects";
import { BaseMemberDraft } from "./BaseMemberDraft";
import {
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
  const [view, setView] = useState<string>();
  const [error, setError] = useState<string>();
  const [diagnostics, setDiagnostics] = useState<BaseMemberDiagnostic[]>([]);

  const definition = detail.data;
  const views = definition?.views ?? [];
  const activeView = view ?? views[0]?.name;
  const capability = definition?.member_creation?.find(
    (candidate) =>
      candidate.view.toLowerCase() === (activeView ?? "").toLowerCase(),
  );
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
    if (!definition || !activeView) return;
    setError(undefined);
    setDiagnostics([]);
    const requestFields: BaseMemberDraftValue["fields"] = {};
    for (const key in value.fields) {
      if (!Object.hasOwn(value.fields, key)) continue;
      const fieldValue = value.fields[key];
      if (fieldValue !== null) requestFields[key] = fieldValue;
    }
    try {
      const created = await createMember.mutateAsync({
        params: { path: { slug } },
        body: {
          base_revision: definition.revision,
          view: activeView,
          title: value.title.trim(),
          fields: requestFields,
        },
      });
      onCreated(created.path, created.title);
    } catch (failure) {
      // The draft stays mounted with its values; only the report changes.
      setError(formatApiError(failure, "Member could not be created."));
      setDiagnostics(decodeBaseMemberDiagnostics(failure));
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

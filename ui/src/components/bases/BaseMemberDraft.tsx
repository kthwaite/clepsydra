import {
  type KeyboardEvent,
  type PointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { BaseMemberDiagnostic } from "#/api/bases";
import { KindSelect } from "#/components/codex/KindSelect";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { TagInput } from "#/components/ui/tag-input";
import type { Kind } from "#/lib/kind";
import { EditableCell } from "./EditableCell";
import type { CellValue } from "./cells/types";
import {
  type BaseMemberDraftField,
  type BaseMemberDraftValue,
  initialMemberDraft,
} from "./member-draft";

export interface BaseMemberDraftProps {
  fields: BaseMemberDraftField[];
  projects: string[];
  isSaving: boolean;
  diagnostics: BaseMemberDiagnostic[];
  summaryError?: string;
  onSave(value: BaseMemberDraftValue): void;
  onCancel(): void;
  onChange?(): void;
}

function fieldLabel(key: string): string {
  return key
    .replace(/^sys\.|^prop\./, "")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}


function requirementText(field: BaseMemberDraftField): string | undefined {
  if (field.membership && field.viewOnly) {
    return "Required for base membership and the active view.";
  }
  if (field.membership) return "Required for base membership.";
  if (field.viewOnly) return "Required for the active view.";
  return undefined;
}


interface DraftFieldControlProps {
  field: BaseMemberDraftField;
  value: CellValue | undefined;
  projects: string[];
  describedBy?: string;
  onChange(key: string, value: CellValue): void;
}

function DraftFieldControl({
  field,
  value,
  projects,
  describedBy,
  onChange,
}: DraftFieldControlProps) {
  const label = `New member — ${fieldLabel(field.key)}`;

  if (field.kind === "kind") {
    return (
      <KindSelect
        value={(typeof value === "string" ? value : "NOTE") as Kind}
        inferred={false}
        ariaLabel={label}
        ariaDescribedBy={describedBy}
        onAssign={(kind) => onChange(field.key, kind)}
      />
    );
  }

  if (field.kind === "project") {
    return (
      <div data-draft-editor>
        <ProjectCombo
          value={typeof value === "string" ? value : null}
          options={projects}
          ariaLabel={label}
          ariaDescribedBy={describedBy}
          onAssign={(project) => onChange(field.key, project)}
          onClear={() => onChange(field.key, null)}
        />
      </div>
    );
  }

  if (field.kind === "tags" || field.kind === "aliases") {
    return (
      <div data-draft-editor>
        <TagInput
          label={fieldLabel(field.key)}
          values={
            Array.isArray(value)
              ? value.filter((item): item is string => typeof item === "string")
              : []
          }
          ariaLabel={label}
          ariaDescribedBy={describedBy}
          onChange={(values) => onChange(field.key, values)}
          placeholder="Add value"
        />
      </div>
    );
  }

  if (field.kind === "property" && field.definition) {
    return (
      <div data-draft-editor>
        <EditableCell
          value={value ?? null}
          definition={field.definition}
          ariaLabel={label}
          commitOnBlur
          ariaDescribedBy={describedBy}
          onCommit={(next) => onChange(field.key, next)}
        />
      </div>
    );
  }

  return null;
}

function focusFirstControl(container: HTMLElement | null): void {
  container
    ?.querySelector<HTMLElement>(
      'input:not([type="hidden"]):not([disabled]), button:not([disabled]), select:not([disabled])',
    )
    ?.focus();
}

export function BaseMemberDraft({
  fields,
  projects,
  isSaving,
  diagnostics,
  summaryError,
  onSave,
  onCancel,
  onChange,
}: BaseMemberDraftProps) {
  const [draft, setDraft] = useState(() => initialMemberDraft(fields));
  const [titleError, setTitleError] = useState<string>();
  const draftRef = useRef(draft);
  const fieldNodes = useRef(new Map<string, HTMLElement>());
  const descriptionPrefix = useId();

  const updateDraft = (next: BaseMemberDraftValue) => {
    draftRef.current = next;
    setDraft(next);
    onChange?.();
  };

  const updateField = (key: string, value: CellValue) => {
    updateDraft({
      ...draftRef.current,
      fields: { ...draftRef.current.fields, [key]: value },
    });
  };

  const updateTitle = (title: string) => {
    if (title.trim() !== "") setTitleError(undefined);
    updateDraft({ ...draftRef.current, title });
  };

  const submit = () => {
    if (isSaving) return;
    if (draftRef.current.title.trim() === "") {
      setTitleError("Title is required.");
      focusFirstControl(fieldNodes.current.get("title") ?? null);
      return;
    }
    onSave(draftRef.current);
  };

  const commitActiveEditor = () => {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !active.closest("[data-draft-editor]")) {
      return;
    }
    active.dispatchEvent(
      new globalThis.KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      }),
    );
  };

  useEffect(() => {
    for (const diagnostic of diagnostics) {
      if (!diagnostic.field) continue;
      const node = fieldNodes.current.get(diagnostic.field);
      if (node) {
        focusFirstControl(node);
        return;
      }
    }
  }, [diagnostics]);

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>) => {
    if (event.defaultPrevented || isSaving) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitActiveEditor();
      submit();
    }
  };

  const handleSavePointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (!event.defaultPrevented) commitActiveEditor();
  };

  const alertMessage =
    summaryError ??
    titleError ??
    (diagnostics.length > 0 ? "Please correct the highlighted fields." : undefined);

  return (
    <form
      aria-label="New base member"
      className="border border-rule bg-paper"
      onKeyDown={handleKeyDown}
    >
      <fieldset disabled={isSaving} className="m-0 border-0 p-0">
        <legend className="sr-only">New base member</legend>
        <div className="flex flex-wrap items-start gap-2 p-2">
          {fields.map((field) => {
            const key = field.key;
            const fieldDiagnostics = diagnostics.filter(
              (diagnostic) => diagnostic.field === key,
            );
            const requirement = requirementText(field);
            const localError = field.kind === "title" ? titleError : undefined;
            const idKey = encodeURIComponent(key).replaceAll("%", "_");
            const requirementId = requirement
              ? `${descriptionPrefix}-${idKey}-requirement`
              : undefined;
            const diagnosticId =
              fieldDiagnostics.length > 0
                ? `${descriptionPrefix}-${idKey}-diagnostic`
                : undefined;
            const localErrorId = localError
              ? `${descriptionPrefix}-${idKey}-local-error`
              : undefined;
            const describedBy =
              [requirementId, diagnosticId, localErrorId]
                .filter((id): id is string => Boolean(id))
                .join(" ") || undefined;
            const label = `New member — ${fieldLabel(field.key)}`;

            return (
              <div
                key={field.key}
                ref={(node) => {
                  if (node) fieldNodes.current.set(key, node);
                  else fieldNodes.current.delete(key);
                }}
                className="min-w-32 flex-1"
              >
                <span className="cl-mono block text-[10px] uppercase tracking-[0.08em] text-ink-mute">
                  {fieldLabel(field.key)}
                </span>
                {field.kind === "title" ? (
                  <input
                    autoFocus
                    aria-label={label}
                    aria-describedby={describedBy}
                    value={draft.title}
                    onChange={(event) => updateTitle(event.target.value)}
                    className="cl-mono w-full border border-rule bg-transparent px-1.5 py-0.5 text-[12px] text-ink outline-none hover:border-accent focus:border-accent"
                  />
                ) : (
                  <DraftFieldControl
                    field={field}
                    value={draft.fields[field.key]}
                    projects={projects}
                    describedBy={describedBy}
                    onChange={updateField}
                  />
                )}
                {describedBy ? (
                  <div className="cl-mono mt-1 text-[10px] text-ink-mute">
                    {requirement ? (
                      <span id={requirementId}>{requirement}</span>
                    ) : null}
                    {diagnosticId ? (
                      <span id={diagnosticId} className="block text-hot">
                        {fieldDiagnostics.map((diagnostic) => (
                          <span
                            key={`${diagnostic.filter_path ?? "field"}-${diagnostic.message}`}
                            className="block"
                          >
                            {diagnostic.message}
                          </span>
                        ))}
                      </span>
                    ) : null}
                    {localError ? (
                      <span id={localErrorId} className="block text-hot">
                        {localError}
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
          <div className="flex items-center gap-1 self-end">
            <button
              type="button"
              aria-label="Save new member"
              onPointerDown={handleSavePointerDown}
              onClick={submit}
              className="cl-mono border border-accent px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink outline-none hover:bg-highlight focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-ink-mute"
            >
              Save
            </button>
            <button
              type="button"
              aria-label="Cancel new member"
              onClick={onCancel}
              className="cl-mono border border-rule px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink-2 outline-none hover:border-accent focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent disabled:cursor-not-allowed disabled:text-ink-mute"
            >
              Cancel
            </button>
          </div>
        </div>
      </fieldset>
      {alertMessage ? (
        <div role="alert" className="border-t border-rule px-2 py-1 text-[11px] text-hot">
          {alertMessage}
        </div>
      ) : null}
    </form>
  );
}

import { CopyButton } from "#/components/ui/CopyButton";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import { DefinitionSectionHeading } from "./DefinitionHeader";
import type { BaseDraft } from "./definition-model";

const LABEL = "text-[12.5px] text-mute";
const FIELD = cn(
  "mt-1.5 w-full rounded-[10px] bg-sink px-3 text-[14px] text-ink placeholder:text-mute aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-hot",
  FOCUS_RING_NATIVE,
);

interface GeneralEditorProps {
  slug: string;
  draft: BaseDraft;
  setDraft: (update: (draft: BaseDraft) => BaseDraft) => void;
  diagnostics: BaseDiagnostic[];
  focusDiagnostic: (path: string) => void;
  registerFocusTarget: RegisterFocusTarget;
}

export function GeneralEditor({
  slug,
  draft,
  diagnostics,
  setDraft,
  registerFocusTarget,
}: GeneralEditorProps) {
  const nameDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "name",
  );
  const nameInvalid = nameDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const templateDiagnostics = diagnostics.filter(
    (diagnostic) => diagnostic.path === "title_template",
  );
  const templateInvalid = templateDiagnostics.some(
    (diagnostic) => diagnostic.severity === "error",
  );
  const path = `bases/${slug}.base.toml`;

  return (
    <section aria-labelledby="general-editor-heading">
      <DefinitionSectionHeading
        id="general-editor-heading"
        title="General"
        description="Naming and file identity for this saved view."
      />

      <div className="mt-[22px] ml-[17px] grid max-w-2xl gap-5">
        <div className="flex flex-col">
          <label htmlFor="base-name" className={LABEL}>
            Name
          </label>
          <input
            id="base-name"
            ref={(element) => registerFocusTarget("name", element)}
            value={draft.name}
            onChange={(event) =>
              setDraft((current) => ({ ...current, name: event.target.value }))
            }
            aria-invalid={nameInvalid || undefined}
            aria-describedby={
              nameDiagnostics.length > 0 ? "base-name-error" : undefined
            }
            className={cn(FIELD, "h-10")}
          />
          {nameDiagnostics.length > 0 ? (
            <p id="base-name-error" className="mt-1.5 text-[12.5px] text-hot">
              {nameDiagnostics
                .map((diagnostic) => diagnostic.message)
                .join(" ")}
            </p>
          ) : null}
        </div>

        <label className="flex flex-col">
          <span className={LABEL}>Description</span>
          <textarea
            ref={(element) => registerFocusTarget("description", element)}
            value={draft.description ?? ""}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                description: event.target.value || undefined,
              }))
            }
            rows={4}
            className={cn(FIELD, "resize-y py-2.5 leading-6")}
          />
        </label>

        <label className="flex flex-col">
          <span className={LABEL}>Title template</span>
          <span className="mt-1 text-[12.5px] leading-5 text-mute">
            Proposes a title for new members, interpolating {"{field}"}{" "}
            placeholders from the draft. Authors can always override it.
          </span>
          <input
            ref={(element) => registerFocusTarget("title_template", element)}
            value={draft.titleTemplate ?? ""}
            placeholder="{author} — {work}"
            aria-invalid={templateInvalid || undefined}
            aria-describedby={
              templateDiagnostics.length > 0
                ? "base-title-template-error"
                : undefined
            }
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                titleTemplate: event.target.value || undefined,
              }))
            }
            className={cn(FIELD, "h-10")}
          />
          {templateDiagnostics.length > 0 ? (
            <p
              id="base-title-template-error"
              className="mt-1.5 text-[12.5px] text-hot"
            >
              {templateDiagnostics
                .map((diagnostic) => diagnostic.message)
                .join(" ")}
            </p>
          ) : null}
        </label>

        <dl className="grid gap-4 rounded-[14px] bg-sink px-[18px] py-4 sm:grid-cols-2">
          <div className="min-w-0">
            <dt className={LABEL}>Slug</dt>
            <dd className="mt-1.5 break-all text-[14px] text-ink">{slug}</dd>
          </div>
          <div className="min-w-0">
            <dt className={LABEL}>Base file</dt>
            <dd className="mt-1 flex min-w-0 items-center gap-2 text-[14px] text-ink">
              <span className="break-all">{path}</span>
              <CopyButton getText={() => path} label="Copy base file path" />
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

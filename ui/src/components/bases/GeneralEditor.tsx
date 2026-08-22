import { CopyButton } from "#/components/ui/CopyButton";
import type {
  BaseDiagnostic,
  RegisterFocusTarget,
} from "./BaseDefinitionWorkspace";
import type { BaseDraft } from "./definition-model";

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
      <h2
        id="general-editor-heading"
        className="text-sm font-bold uppercase tracking-widest text-foreground"
      >
        General
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Naming and file identity for this saved view.
      </p>

      <div className="mt-5 grid gap-5">
        <div className="flex flex-col">
          <label htmlFor="base-name">
            <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Name
            </span>
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
            className="mt-2 w-full border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          />
          {nameDiagnostics.length > 0 ? (
            <p
              id="base-name-error"
              className={
                nameInvalid
                  ? "mt-1 text-xs text-destructive"
                  : "mt-1 text-xs text-warn"
              }
            >
              {nameDiagnostics
                .map((diagnostic) => diagnostic.message)
                .join(" ")}
            </p>
          ) : null}
        </div>

        <label className="flex flex-col">
          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Description
          </span>
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
            className="mt-2 w-full resize-y border border-input bg-background px-3 py-2 text-sm leading-6 text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          />
        </label>

        <label className="flex flex-col">
          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Title template
          </span>
          <span className="mt-1 text-xs leading-5 text-muted-foreground">
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
            className="mt-2 w-full border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          />
          {templateDiagnostics.length > 0 ? (
            <p
              id="base-title-template-error"
              className={
                templateInvalid
                  ? "mt-1 text-xs text-destructive"
                  : "mt-1 text-xs text-warn"
              }
            >
              {templateDiagnostics
                .map((diagnostic) => diagnostic.message)
                .join(" ")}
            </p>
          ) : null}
        </label>

        <dl className="grid gap-4 border-t border-border pt-4 sm:grid-cols-2">
          <div>
            <dt className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Slug
            </dt>
            <dd className="mt-2 font-mono text-sm text-foreground">{slug}</dd>
          </div>
          <div>
            <dt className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Base file
            </dt>
            <dd className="mt-2 flex min-w-0 items-center gap-2 font-mono text-sm text-foreground">
              <span className="break-all">{path}</span>
              <CopyButton getText={() => path} label="Copy base file path" />
            </dd>
          </div>
        </dl>
      </div>
    </section>
  );
}

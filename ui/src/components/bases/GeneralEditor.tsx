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
  setDraft,
  registerFocusTarget,
}: GeneralEditorProps) {
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
        <label className="flex flex-col">
          <span className="text-xs font-bold uppercase tracking-widest text-muted-foreground">
            Name
          </span>
          <input
            ref={(element) => registerFocusTarget("name", element)}
            value={draft.name}
            onChange={(event) =>
              setDraft((current) => ({ ...current, name: event.target.value }))
            }
            className="mt-2 w-full border border-input bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-ring focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          />
        </label>

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

import { type FormEvent, useRef, useState } from "react";
import { useTags } from "#/api/index";
import { useAssignPage, useCreatePage } from "#/api/pages";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { KindSelect } from "#/components/codex/KindSelect";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { TagsInput } from "#/components/codex/TagsInput";
import { useOpenTab } from "#/hooks/useOpenTab";
import { generateShortId, intakePath } from "#/lib/intake";
import type { Kind } from "#/lib/kind";
import { useProjects } from "#/lib/useProjects";
import { useUiStore } from "#/store/ui";

/** Quick-capture "INTAKE" terminal — mounted globally, opened via ⌘N / palette.
 * Kind + project drive the destination via the same projection rules as the
 * folio META rail (ADR 0001/0002); the path is derived, never typed. */
export function InscribeModal() {
  const isOpen = useUiStore((s) => s.isInscribeOpen);
  const onClose = useUiStore((s) => s.closeInscribe);
  const [kind, setKind] = useState<Kind>("NOTE");
  const [project, setProject] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  // TagsInput commits a pending draft on blur; when that blur is caused by the
  // submit click the state update hasn't propagated by the time the submit
  // handler runs, so reads go through this ref.
  const tagsRef = useRef<string[]>(tags);
  // One id per intake so the path preview is stable across keystrokes.
  const [shortId, setShortId] = useState(generateShortId);
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePage();
  const assign = useAssignPage();
  const openTab = useOpenTab();
  const projects = useProjects();
  const { data: tagIndex } = useTags();

  if (!isOpen) return null;

  const updateTags = (next: string[]) => {
    tagsRef.current = next;
    setTags(next);
  };

  const destination = intakePath({
    kind,
    project,
    title: title.trim(),
    shortId,
    now: new Date(),
  });

  const finish = (path: string, label: string) => {
    openTab("page", path, label);
    reset();
    onClose();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("title is required");
      return;
    }
    const path = intakePath({
      kind,
      project,
      title: trimmedTitle,
      shortId,
      now: new Date(),
    });
    const finalTags = tagsRef.current;
    create.mutate(
      {
        params: { path: { path } },
        body: {
          title: trimmedTitle,
          tags: finalTags.length ? finalTags : undefined,
        },
      },
      {
        onSuccess: () => {
          // Declare kind/project explicitly so the folio META rail shows them
          // as assigned rather than folder-inferred. The page already sits at
          // its projected path, so no move follows; if the declaration fails
          // the page still exists — open it rather than stranding the modal.
          assign.mutate(
            {
              params: { path: { path } },
              body: { kind, ...(project ? { project } : {}) },
            },
            {
              onSuccess: (data) => finish(data.path ?? path, trimmedTitle),
              onError: () => finish(path, trimmedTitle),
            },
          );
        },
        onError: (err) =>
          setError(String((err as { error?: unknown }).error ?? err)),
      },
    );
  };

  const reset = () => {
    setKind("NOTE");
    setProject(null);
    setTitle("");
    updateTags([]);
    setShortId(generateShortId());
    setError(null);
  };

  const dismiss = () => {
    reset();
    onClose();
  };

  return (
    <CodexModalShell
      ariaLabel="Intake"
      maxWidthClassName="max-w-[520px]"
      onDismiss={dismiss}
    >
      <form onSubmit={submit}>
        {/* terminal header */}
        <div className="flex items-baseline justify-between border-b border-ink bg-paper-2 px-3 py-1.5">
          <span className="cl-mono text-[10px] uppercase tracking-[0.18em] text-ink">
            ▣ Intake
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            FORM CLP-INTAKE-04 / REV.08
          </span>
        </div>

        <div className="px-4 py-3">
          <div className="mb-2.5 grid grid-cols-2 gap-3">
            <Field label="01 · Kind">
              <div className="mt-1">
                <KindSelect value={kind} inferred={false} onAssign={setKind} />
              </div>
            </Field>
            <Field label="02 · Project · optional">
              {/* Enter commits the combobox draft; keep it from also
                  submitting the form before the state lands. */}
              <div
                className="mt-1"
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.preventDefault();
                }}
              >
                <ProjectCombo
                  key={project ?? ""}
                  value={project}
                  options={projects}
                  onAssign={setProject}
                  onClear={() => setProject(null)}
                />
              </div>
            </Field>
          </div>
          <Field label="03 · Title">
            <input
              aria-label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
              placeholder="new folio title"
              className="cl-mono mt-1 w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
            />
          </Field>
          <Field label="04 · Tags">
            <TagsInput
              value={tags}
              onChange={updateTags}
              suggestions={(tagIndex ?? []).map((t) => t.tag)}
              placeholder="⇥ to complete"
            />
          </Field>
          <div className="cl-mono mb-2.5 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            REF · <span className="normal-case">{destination}</span>
          </div>
          {error && (
            <div className="cl-mono mb-2 text-[11px] text-hot">⁂ {error}</div>
          )}
          <div className="flex justify-end gap-2">
            <button type="button" className="cl-btn" onClick={dismiss}>
              cancel
            </button>
            <button
              type="submit"
              className="cl-btn cl-btn-hot"
              disabled={create.isPending || assign.isPending}
            >
              {create.isPending || assign.isPending
                ? "committing…"
                : "▣ commit to archive"}
            </button>
          </div>
        </div>
      </form>
    </CodexModalShell>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2.5 block">
      <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </span>
      {children}
    </div>
  );
}

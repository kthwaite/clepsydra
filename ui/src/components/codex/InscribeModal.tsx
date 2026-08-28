import { type FormEvent, useRef, useState } from "react";
import { useTags } from "#/api/index";
import { useCreatePage } from "#/api/pages";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { KindSelect } from "#/components/codex/KindSelect";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { TagInput } from "#/components/ui/tag-input";
import { useOpenTab } from "#/hooks/useOpenTab";
import { generateShortId, intakePath } from "#/lib/intake";
import type { Kind } from "#/lib/kind";
import { isOneOnOne, withOneOnOne } from "#/lib/meeting";
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
  // TagInput commits a pending draft on blur; when that blur is caused by the
  // submit click the state update hasn't propagated by the time the submit
  // handler runs, so reads go through this ref.
  const tagsRef = useRef<string[]>(tags);
  const projectComboRef = useRef<HTMLDivElement | null>(null);
  // One id per intake so the path preview is stable across keystrokes.
  const [shortId, setShortId] = useState(generateShortId);
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePage();
  const openTab = useOpenTab();
  const projects = useProjects();
  const { data: tagIndex } = useTags();
  // Choosing a Base hands the form to the member draft: same composition and
  // same endpoint as the Base table's own Add member.

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
          kind,
          ...(project ? { project } : {}),
        },
      },
      {
        onSuccess: (data) => finish(data.path ?? path, trimmedTitle),
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
      <form
        onSubmit={submit}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            projectComboRef.current?.contains(event.target as Node)
          ) {
            event.preventDefault();
          }
        }}
      >
        {/* terminal header */}
        <div className="flex items-baseline justify-between border-b border-ink bg-paper-2 px-3 py-1.5">
          <span className="cl-serif text-[10px] uppercase tracking-[0.18em] text-ink">
            ▣ Intake
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
              <div ref={projectComboRef} className="mt-1">
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
              // biome-ignore lint/a11y/noAutofocus: the intake modal intentionally starts focus at its primary title field
              autoFocus
              placeholder="new folio title"
              className="cl-serif mt-1 w-full border border-rule bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
            />
          </Field>
          <Field label="04 · Tags">
            <TagInput
              label="Tags"
              ariaLabel="Tags"
              values={tags}
              suggestions={(tagIndex ?? []).map((tag) => tag.tag)}
              onChange={updateTags}
              placeholder="⇥ to complete"
              variant="codex"
              valuePrefix="#"
              maxSuggestions={8}
            />
            {/* TODO: we'll probably want more than one of these, with better semantics */}
            {kind === "MEETING" && (
              // A 1:1 is a MEETING tagged `1:1` (ADR 0006): the box edits the
              // same tag list the chips above show.
              <label className="cl-mono mt-1.5 flex cursor-pointer items-center gap-1.5 text-[10px] uppercase tracking-[0.14em] text-ink-mute">
                <input
                  type="checkbox"
                  checked={isOneOnOne(tags)}
                  onChange={(event) =>
                    updateTags(
                      withOneOnOne(tagsRef.current, event.target.checked),
                    )
                  }
                />
                1:1
              </label>
            )}
          </Field>
          <div className="cl-mono mb-2.5 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
            DESTINATION · <span className="normal-case">{destination}</span>
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
              disabled={create.isPending}
            >
              {create.isPending ? "committing…" : "▣ commit to archive"}
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
      <span className="cl-serif text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </span>
      {children}
    </div>
  );
}

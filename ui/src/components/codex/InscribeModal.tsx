import { type FormEvent, useRef, useState } from "react";
import { useTags } from "#/api/index";
import { useCreatePage } from "#/api/pages";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { KindSelect } from "#/components/codex/KindSelect";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { Button } from "#/components/ui/button";
import { TagInput } from "#/components/ui/tag-input";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { generateShortId, intakePath } from "#/lib/intake";
import type { Kind } from "#/lib/kind";
import { type KindIntakeValues, presentationFor } from "#/lib/kindPresentation";
import { useProjects } from "#/lib/useProjects";
import { useUiStore } from "#/store/ui";

/** Quick-capture Inscribe modal — mounted globally, opened via ⌘N / palette.
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
  const [intakeValues, setIntakeValues] = useState<
    Partial<Record<Kind, KindIntakeValues>>
  >({});
  // One id per intake so the path preview is stable across keystrokes.
  const [shortId, setShortId] = useState(generateShortId);
  const [error, setError] = useState<string | null>(null);
  const create = useCreatePage();
  const openTab = useOpenTab();
  const projects = useProjects();
  const { data: tagIndex } = useTags();

  if (!isOpen) return null;

  const updateTags = (next: string[]) => {
    tagsRef.current = next;
    setTags(next);
  };

  const intake = presentationFor(kind).intake;
  const IntakeFields = intake?.Fields;
  const currentIntakeValues = intakeValues[kind] ?? {};

  const assignKind = (next: Kind) => {
    setKind(next);
    const definition = presentationFor(next).intake;
    if (definition && !intakeValues[next]) {
      setIntakeValues((values) => ({
        ...values,
        [next]: definition.initialValues(),
      }));
    }
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
          ...intake?.serialize(currentIntakeValues),
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
    setIntakeValues({});
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
      maxWidthClassName="max-w-[560px]"
      panelClassName="rounded-[18px]"
      onDismiss={dismiss}
    >
      <form
        onSubmit={submit}
        onKeyDown={(event) => {
          if (
            event.key === "Enter" &&
            event.target instanceof HTMLElement &&
            event.target.getAttribute("role") === "combobox"
          ) {
            event.preventDefault();
          }
        }}
        className="flex flex-col gap-[22px] px-6 py-7 md:px-9 md:py-8"
      >
        <div className="flex items-start gap-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <h2 className="font-serif text-[34px] font-normal leading-[1.05] text-ink">
              Inscribe <span className="italic">a new folio</span>
            </h2>
            <span className="text-[13px] text-mute">
              Kind and project decide where it is filed
            </span>
          </div>
          <span className="mt-1.5 shrink-0 rounded-md bg-sink px-2 py-0.5 text-[12.5px] text-mute">
            ⌘N
          </span>
        </div>

        <div className="grid grid-cols-2 gap-3.5">
          <Field label="Kind">
            <KindSelect value={kind} inferred={false} onAssign={assignKind} />
          </Field>
          <Field
            label={
              <>
                Project <span className="text-mute">· optional</span>
              </>
            }
          >
            <ProjectCombo
              value={project}
              options={projects}
              onAssign={setProject}
              onClear={() => setProject(null)}
            />
          </Field>
        </div>
        <Field label="Title">
          <input
            aria-label="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            // biome-ignore lint/a11y/noAutofocus: the intake modal intentionally starts focus at its primary title field
            autoFocus
            placeholder="New folio title"
            className={cn(
              "h-[54px] w-full shrink-0 rounded-xl bg-sink px-4 font-serif text-[26px] text-ink placeholder:text-mute",
              FOCUS_RING_NATIVE,
            )}
          />
        </Field>
        {IntakeFields && (
          <IntakeFields
            value={currentIntakeValues}
            onChange={(value) =>
              setIntakeValues((values) => ({ ...values, [kind]: value }))
            }
          />
        )}
        <TagInput
          label="Tags"
          ariaLabel="Tags"
          values={tags}
          suggestions={(tagIndex ?? []).map((tag) => tag.tag)}
          onChange={updateTags}
          placeholder="Tab to complete"
          variant="codex"
          valuePrefix="#"
          maxSuggestions={8}
        />
        <div className="flex flex-col gap-[3px] rounded-xl bg-ground px-4 py-3">
          <span className="text-[12.5px] text-mute">Destination</span>
          <span className="break-all text-[13.5px] text-ink-2">
            {destination}
          </span>
        </div>
        {error && (
          <div role="alert" className="text-[13.5px] text-hot">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onPress={dismiss}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" isDisabled={create.isPending}>
            {create.isPending ? "Inscribing…" : "Inscribe"}
          </Button>
        </div>
      </form>
    </CodexModalShell>
  );
}

function Field({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] text-mute">{label}</span>
      {children}
    </div>
  );
}

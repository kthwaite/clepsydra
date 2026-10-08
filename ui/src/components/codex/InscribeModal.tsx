import { X } from "lucide-react";
import { type FormEvent, useId, useRef, useState } from "react";
import { useTags } from "#/api/index";
import { useCreatePage } from "#/api/pages";
import { CodexModalShell } from "#/components/codex/CodexModalShell";
import { KindSelect } from "#/components/codex/KindSelect";
import { PersonCombo } from "#/components/codex/PersonCombo";
import { ProjectCombo } from "#/components/codex/ProjectCombo";
import { Button } from "#/components/ui/button";
import { TagInput } from "#/components/ui/tag-input";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { generateShortId, intakePath } from "#/lib/intake";
import type { Kind } from "#/lib/kind";
import { localIso, withSeconds } from "#/lib/meeting";
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
  const projectComboRef = useRef<HTMLDivElement | null>(null);
  const attendeeComboRef = useRef<HTMLDivElement | null>(null);
  // MEETING-only fields. They outlive a kind switch but are sent only while
  // the kind is MEETING.
  const [occurredAt, setOccurredAt] = useState("");
  const [attendees, setAttendees] = useState<string[]>([]);
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

  const isMeeting = kind === "MEETING";

  const assignKind = (next: Kind) => {
    setKind(next);
    if (next === "MEETING" && occurredAt === "") setOccurredAt(nowLocal());
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
    const meeting = isMeeting
      ? {
          ...(attendees.length ? { attendees } : {}),
          ...(occurredAt ? { occurred_at: withSeconds(occurredAt) } : {}),
        }
      : {};
    create.mutate(
      {
        params: { path: { path } },
        body: {
          title: trimmedTitle,
          tags: finalTags.length ? finalTags : undefined,
          kind,
          ...(project ? { project } : {}),
          ...meeting,
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
    setOccurredAt("");
    setAttendees([]);
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
          const target = event.target as Node;
          if (
            event.key === "Enter" &&
            (projectComboRef.current?.contains(target) ||
              attendeeComboRef.current?.contains(target))
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
            {/* Enter commits the combobox draft; keep it from also
                submitting the form before the state lands. */}
            <div ref={projectComboRef}>
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
        {isMeeting && (
          <MeetingFields
            occurredAt={occurredAt}
            onOccurredAtChange={setOccurredAt}
            attendees={attendees}
            onAttendeesChange={setAttendees}
            comboRef={attendeeComboRef}
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
        {error && <div className="text-[13.5px] text-hot">{error}</div>}
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

/** The current local time, floored to the minute, as a datetime-local value. */
function nowLocal(): string {
  const now = new Date();
  now.setSeconds(0, 0);
  return localIso(now).slice(0, 16);
}

/** When and Attendees for a MEETING, collected before the page exists and
 * sent with the create request. */
function MeetingFields({
  occurredAt,
  onOccurredAtChange,
  attendees,
  onAttendeesChange,
  comboRef,
}: {
  occurredAt: string;
  onOccurredAtChange: (value: string) => void;
  attendees: string[];
  onAttendeesChange: (next: string[]) => void;
  comboRef: React.RefObject<HTMLDivElement | null>;
}) {
  const attendeesLabelId = useId();

  const add = (name: string) => {
    // PersonCombo hides people already listed; this guards a typed Enter.
    if (attendees.some((a) => a.toLowerCase() === name.toLowerCase())) return;
    onAttendeesChange([...attendees, name]);
  };

  return (
    <>
      <Field label="When">
        <input
          type="datetime-local"
          aria-label="When"
          value={occurredAt}
          onChange={(e) => onOccurredAtChange(e.target.value)}
          className={cn(
            "h-8 w-full max-w-[16rem] rounded-lg bg-sink px-2.5 text-[13.5px] text-ink",
            FOCUS_RING_NATIVE,
          )}
        />
      </Field>
      {/* The whole box carries the focus ring, as TagInput's does, so
          PersonCombo's own inset ring is switched off here. */}
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 rounded-[14px] bg-sink px-2 py-1.5 has-[input:focus-visible]:ring-2 has-[input:focus-visible]:ring-accent [&_input[data-focus-visible]]:ring-0">
        <span id={attendeesLabelId} className="text-[12.5px] text-mute">
          Attendees:
        </span>
        {attendees.length > 0 && (
          <ul aria-labelledby={attendeesLabelId} className="contents list-none">
            {attendees.map((attendee) => (
              <li
                key={attendee}
                className="flex h-7 max-w-[16rem] min-w-0 items-center gap-0.5 rounded-full bg-raise pr-0.5 pl-2.5 text-[13px] text-ink-2"
              >
                <span className="truncate">{attendee}</span>
                <button
                  type="button"
                  aria-label={`remove ${attendee}`}
                  onClick={() =>
                    onAttendeesChange(attendees.filter((a) => a !== attendee))
                  }
                  className={cn(
                    "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full text-mute hover:text-ink",
                    FOCUS_RING_NATIVE,
                  )}
                >
                  <X className="h-3 w-3" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* Enter commits the combobox draft; the form guard keeps it from
            also submitting. */}
        <div ref={comboRef} className="flex min-w-[8ch] flex-1">
          <PersonCombo
            onPick={add}
            exclude={attendees}
            ariaLabel="Add attendee"
          />
        </div>
      </div>
    </>
  );
}

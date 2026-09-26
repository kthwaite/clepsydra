import { Plus, X } from "lucide-react";
import { useId, useState } from "react";
import { usePropertyCommit } from "#/api/bases";
import { usePage } from "#/api/pages";
import type { CellValue } from "#/components/bases/cells/types";
import { EditableCell } from "#/components/bases/EditableCell";
import { CLink } from "#/components/codex/CLink";
import { PersonCombo } from "#/components/codex/PersonCombo";
import { Button } from "#/components/ui/button";
import {
  findPageByName,
  useCreatePerson,
  useIndexedPages,
} from "#/hooks/usePeople";
import { ATTENDEES_KEY, asWikilink, readAttendees } from "#/lib/attendance";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { KindMetaExtrasProps } from "#/lib/kindPresentation";
import {
  floorToQuarterHour,
  isOneOnOne,
  localIso,
  OCCURRED_AT_KEY,
  readOccurredAt,
  withOneOnOne,
} from "#/lib/meeting";

/** The `occurred_at` editor's schema. Declaring it here rather than reading a
 *  Base gives the field the same datetime picker and commit semantics as any
 *  declared property, without requiring the vault to declare a Base for it. */
const OCCURRED_AT_DEFINITION = { type: "datetime" } as const;

/** 24px round icon button inside an attendee chip. */
const CHIP_ICON_BUTTON = cn(
  "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full transition-colors",
  "hover:bg-ground",
  "disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
  FOCUS_RING_NATIVE,
);

const LABEL = "text-[13px] text-mute";

/** MEETING header band: when the meeting happened, which person pages it
 *  names, and whether it is a 1:1. These are facts of the note rather than
 *  sidebar metadata, so FOLIO renders this under the title/tags header
 *  (registered as the kind's `headerExtras`) rather than in the META rail.
 *
 *  `occurred_at` and `attendees` are ordinary frontmatter properties, so this
 *  writes through the same property-patch path the Base rail uses — including
 *  the `datetime` type hint that keeps `occurred_at` a native TOML date-time
 *  rather than a string. The 1:1 is a tag (ADR 0006), so it goes through the
 *  editor's tag state the way the header's tag input does. The backend
 *  re-checks every write; the disabled affordances here only spare the reader
 *  a refusal they can already see coming. */
export function MeetingMeta({
  path,
  isDraft,
  tags,
  onTagsChange,
}: KindMetaExtrasProps) {
  const { data: page } = usePage(path);
  const commit = usePropertyCommit();
  const pages = useIndexedPages();
  const createPerson = useCreatePerson();
  const [saving, setSaving] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const attendeesLabelId = useId();

  const attendees = readAttendees(page?.meta.attendees);
  const occurredAt = readOccurredAt(page?.meta.occurred_at);
  const oneOnOne = isOneOnOne(tags);

  const patch = async (key: string, value: CellValue, hint?: "datetime") => {
    if (!page) return;
    setSaving(true);
    try {
      await commit({ id: page.meta.id, path: page.path }, key, value, hint);
    } finally {
      setSaving(false);
    }
  };

  // `null` clears the key rather than storing an empty list: absence is the
  // only empty state in this vault's frontmatter.
  const write = (next: string[]) =>
    patch(ATTENDEES_KEY, next.length > 0 ? next.map(asWikilink) : null);

  const setOccurredAt = (value: CellValue) =>
    // The hint is load-bearing: without it the splice stores a string, and the
    // server refuses it rather than filing a date nothing can sort on.
    patch(OCCURRED_AT_KEY, value, value === null ? undefined : "datetime");

  const add = (name: string) => {
    // Re-adding someone already named is a no-op, not a duplicate the server
    // would reject. PersonCombo already hides them; this guards Enter.
    if (attendees.some((a) => a.toLowerCase() === name.toLowerCase())) return;
    void write([...attendees, name]);
  };

  const create = async (name: string) => {
    if (creating !== null) return;
    setCreating(name);
    setCreateError(null);
    try {
      await createPerson(name);
    } catch {
      setCreateError(`Could not create “${name}”`);
    } finally {
      setCreating(null);
    }
  };

  return (
    <section
      aria-label="Meeting details"
      data-testid="meeting-header"
      className="mb-3 grid grid-cols-[92px_minmax(0,1fr)] items-start gap-x-4 gap-y-[18px]"
    >
      <div className={cn(LABEL, "pt-2")}>Occurred</div>
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 max-w-[18rem] flex-1">
          <EditableCell
            value={occurredAt}
            definition={OCCURRED_AT_DEFINITION}
            ariaLabel="occurred at"
            commitOnBlur
            onCommit={(value) => void setOccurredAt(value)}
          />
        </div>
        {!isDraft && !occurredAt && (
          <Button
            size="sm"
            isDisabled={saving}
            onPress={() =>
              void setOccurredAt(localIso(floorToQuarterHour(new Date())))
            }
          >
            Now
          </Button>
        )}
      </div>

      <div className="flex flex-col items-start gap-2 pt-1.5">
        <span id={attendeesLabelId} className={LABEL}>
          Attendees
        </span>
        <button
          type="button"
          aria-pressed={oneOnOne}
          title={oneOnOne ? "Tagged 1:1 — untag" : "Tag as a 1:1"}
          className={cn(
            "h-6 cursor-pointer rounded-full px-2.5 text-[12.5px] transition-colors",
            FOCUS_RING_NATIVE,
            oneOnOne
              ? "bg-accent-tint text-accent"
              : "bg-sink text-mute hover:text-ink",
          )}
          onClick={() => onTagsChange(withOneOnOne(tags, !oneOnOne))}
        >
          1:1
        </button>
      </div>

      <div className="flex min-w-0 flex-col gap-2.5">
        {attendees.length === 0 ? (
          <span className="pt-1.5 text-[13.5px] text-mute">No attendees</span>
        ) : (
          <ul
            aria-labelledby={attendeesLabelId}
            className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          >
            {attendees.map((attendee) => {
              const target = findPageByName(pages, attendee);
              return (
                <li
                  key={attendee}
                  className="inline-flex h-[30px] max-w-[16rem] min-w-0 items-center gap-0.5 rounded-full bg-sink pr-1 pl-3 text-[14px]"
                >
                  {target ? (
                    <CLink
                      path={target.path}
                      className="min-w-0 truncate text-ink hover:text-accent"
                    >
                      {attendee}
                    </CLink>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1">
                      <span
                        className="truncate text-mute italic"
                        title="No page carries this name yet"
                      >
                        {attendee}
                      </span>
                      {!isDraft && (
                        <button
                          type="button"
                          className={cn(CHIP_ICON_BUTTON, "text-accent")}
                          disabled={creating !== null}
                          aria-label={`create ${attendee}`}
                          title="Create the person page"
                          onClick={() => void create(attendee)}
                        >
                          <Plus size={12} strokeWidth={2} aria-hidden />
                        </button>
                      )}
                    </span>
                  )}
                  <button
                    type="button"
                    className={cn(CHIP_ICON_BUTTON, "text-mute hover:text-hot")}
                    disabled={saving || isDraft}
                    aria-label={`remove ${attendee}`}
                    onClick={() =>
                      void write(
                        attendees.filter((entry) => entry !== attendee),
                      )
                    }
                  >
                    <X size={12} strokeWidth={2} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {!isDraft && (
          <div className="w-60 max-w-full">
            <PersonCombo onPick={add} exclude={attendees} disabled={saving} />
          </div>
        )}

        {createError && (
          <div className="text-[12.5px] text-hot">{createError}</div>
        )}
      </div>
    </section>
  );
}

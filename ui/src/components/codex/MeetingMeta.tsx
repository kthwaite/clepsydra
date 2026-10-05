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
  localIso,
  OCCURRED_AT_KEY,
  readOccurredAt,
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

/** MEETING header band: when the meeting happened and which person pages it
 *  names. FOLIO renders these facts under the title/tags header.
 *
 *  Both fields use the same property-patch path as Bases, including the
 *  `datetime` hint that keeps `occurred_at` a native TOML date-time. */
export function MeetingMeta({ path, isDraft }: KindMetaExtrasProps) {
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

      <div className="col-span-full flex min-w-0 flex-wrap items-center gap-1.5">
        <span id={attendeesLabelId} className={LABEL}>
          Attendees:
        </span>
        {attendees.length > 0 && (
          <ul aria-labelledby={attendeesLabelId} className="contents list-none">
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
          <PersonCombo onPick={add} exclude={attendees} disabled={saving} />
        )}

        {createError && (
          <div className="text-[12.5px] text-hot">{createError}</div>
        )}
      </div>
    </section>
  );
}

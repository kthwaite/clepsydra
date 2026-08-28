import { useState } from "react";
import { usePropertyCommit } from "#/api/bases";
import { usePage } from "#/api/pages";
import type { CellValue } from "#/components/bases/cells/types";
import { EditableCell } from "#/components/bases/EditableCell";
import {
  ATTENDEES_KEY,
  asWikilink,
  canAddAttendee,
  readAttendees,
} from "#/lib/attendance";
import type { KindMetaExtrasProps } from "#/lib/kindPresentation";
import { localIso, OCCURRED_AT_KEY, readOccurredAt } from "#/lib/meeting";

/** The `occurred_at` editor's schema. Declaring it here rather than reading a
 *  Base gives the field the same datetime picker and commit semantics as any
 *  declared property, without requiring the vault to declare a Base for it. */
const OCCURRED_AT_DEFINITION = { type: "datetime" } as const;

/** MEETING / ONE_ON_ONE header band: when the meeting happened and which
 *  person pages it names. These are facts of the note rather than sidebar
 *  metadata, so FOLIO renders this under the title/tags header (registered as
 *  the kind's `headerExtras`) rather than in the META rail.
 *
 *  Both are ordinary frontmatter properties, so this writes through the same
 *  property-patch path the Base rail uses — including the `datetime` type hint
 *  that keeps `occurred_at` a native TOML date-time rather than a string. The
 *  backend re-checks every write; the disabled affordances here only spare the
 *  reader a refusal they can already see coming. */
export function MeetingMeta({ path, isDraft }: KindMetaExtrasProps) {
  const { data: page } = usePage(path);
  const commit = usePropertyCommit();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const attendees = readAttendees(page?.meta.attendees);
  const occurredAt = readOccurredAt(page?.meta.occurred_at);
  const kind = page?.kind ?? "MEETING";
  const canAdd = !isDraft && !saving && canAddAttendee(kind, attendees.length);

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

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    // Re-adding someone already named is a no-op, not a duplicate the server
    // would reject.
    if (attendees.some((a) => a.toLowerCase() === trimmed.toLowerCase())) {
      setName("");
      return;
    }
    await write([...attendees, trimmed]);
    setName("");
  };

  return (
    <section
      aria-label="Meeting details"
      data-testid="meeting-header"
      className="mb-3 flex flex-wrap items-start gap-x-8 gap-y-2"
    >
      <div className="flex min-w-[12rem] flex-col gap-1">
        <div className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
          Occurred
        </div>
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1">
            <EditableCell
              value={occurredAt}
              definition={OCCURRED_AT_DEFINITION}
              ariaLabel="occurred at"
              commitOnBlur
              onCommit={(value) => void setOccurredAt(value)}
            />
          </div>
          {!isDraft && !occurredAt && (
            <button
              type="button"
              className="cl-btn"
              disabled={saving}
              onClick={() => void setOccurredAt(localIso(new Date()))}
            >
              Now
            </button>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
          {kind === "ONE_ON_ONE" ? "With" : "Attendees"}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {attendees.length === 0 ? (
            <span className="cl-mono text-[11px] text-ink-mute">
              {kind === "ONE_ON_ONE" ? "nobody named yet" : "no attendees"}
            </span>
          ) : (
            attendees.map((attendee) => (
              <span
                key={attendee}
                className="cl-mono inline-flex items-center gap-1 border border-rule px-1.5 py-0.5 text-[11px] text-ink"
              >
                <span className="truncate">{attendee}</span>
                <button
                  type="button"
                  className="cl-btn px-1 py-0"
                  disabled={saving || isDraft}
                  aria-label={`remove ${attendee}`}
                  onClick={() =>
                    write(attendees.filter((entry) => entry !== attendee))
                  }
                >
                  ×
                </button>
              </span>
            ))
          )}

          {canAdd && (
            <>
              <input
                className="cl-mono w-40 border border-rule bg-transparent p-1 text-[12px] text-ink outline-none placeholder:text-ink-mute focus:border-accent"
                value={name}
                placeholder="person"
                aria-label="add attendee"
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void add();
                  }
                }}
              />
              <button
                type="button"
                className="cl-btn"
                disabled={saving || name.trim().length === 0}
                onClick={() => void add()}
              >
                Add
              </button>
            </>
          )}

          {kind === "ONE_ON_ONE" && attendees.length >= 1 && (
            <span className="cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute">
              a 1:1 names one person
            </span>
          )}
        </div>
      </div>
    </section>
  );
}

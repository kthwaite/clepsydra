import { Plus, X } from "lucide-react";
import { useState } from "react";
import { usePropertyCommit } from "#/api/bases";
import { usePage } from "#/api/pages";
import type { CellValue } from "#/components/bases/cells/types";
import { EditableCell } from "#/components/bases/EditableCell";
import { CLink } from "#/components/codex/CLink";
import { PersonCombo } from "#/components/codex/PersonCombo";
import {
  findPageByName,
  useCreatePerson,
  useIndexedPages,
} from "#/hooks/usePeople";
import { ATTENDEES_KEY, asWikilink, readAttendees } from "#/lib/attendance";
import { cn } from "#/lib/cn";
import type { KindMetaExtrasProps } from "#/lib/kindPresentation";
import {
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

/** Icon-sized ghost button: invisible frame until hovered. */
const GHOST_ICON_BUTTON = cn(
  "inline-flex size-5 shrink-0 cursor-pointer items-center justify-center border border-transparent text-ink-mute transition-colors",
  "hover:border-rule hover:text-hot",
  "disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-transparent disabled:hover:text-ink-mute",
);

const LABEL = "cl-mono text-[9px] uppercase tracking-[0.14em] text-ink-mute";

/** MEETING META-rail block: when the meeting happened, which person pages it
 *  names, and whether it is a 1:1.
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
    <div className="flex flex-col gap-3">
      <div>
        <div className={cn(LABEL, "mb-1")}>Occurred</div>
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

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className={LABEL}>Attendees</span>
          <button
            type="button"
            aria-pressed={oneOnOne}
            title={oneOnOne ? "Tagged 1:1 — untag" : "Tag as a 1:1"}
            className={cn(
              "cl-btn px-1.5 py-0 text-[9px]",
              oneOnOne && "cl-btn-hot",
            )}
            onClick={() => onTagsChange(withOneOnOne(tags, !oneOnOne))}
          >
            1:1
          </button>
        </div>

        {attendees.length === 0 ? (
          <div className="cl-mono text-[11px] text-ink-mute">no attendees</div>
        ) : (
          <ul className="flex flex-col gap-1">
            {attendees.map((attendee) => {
              const target = findPageByName(pages, attendee);
              return (
                <li
                  key={attendee}
                  className="flex items-center justify-between gap-2"
                >
                  {target ? (
                    <CLink
                      path={target.path}
                      className="cl-mono min-w-0 truncate text-[12px] text-ink hover:text-accent"
                    >
                      {attendee}
                    </CLink>
                  ) : (
                    <span className="flex min-w-0 items-center gap-1">
                      <span
                        className="cl-mono truncate text-[12px] text-ink-mute"
                        title="no page carries this name yet"
                      >
                        {attendee}
                      </span>
                      {!isDraft && (
                        <button
                          type="button"
                          className={GHOST_ICON_BUTTON}
                          disabled={creating !== null}
                          aria-label={`create ${attendee}`}
                          title="create the person page"
                          onClick={() => void create(attendee)}
                        >
                          <Plus size={11} aria-hidden />
                        </button>
                      )}
                    </span>
                  )}
                  <button
                    type="button"
                    className={GHOST_ICON_BUTTON}
                    disabled={saving || isDraft}
                    aria-label={`remove ${attendee}`}
                    onClick={() =>
                      void write(
                        attendees.filter((entry) => entry !== attendee),
                      )
                    }
                  >
                    <X size={11} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {createError && (
          <div className="cl-mono mt-1 text-[10px] text-hot">
            ⁂ {createError}
          </div>
        )}

        {!isDraft && (
          <div className="mt-2">
            <PersonCombo onPick={add} exclude={attendees} disabled={saving} />
          </div>
        )}
      </div>
    </div>
  );
}

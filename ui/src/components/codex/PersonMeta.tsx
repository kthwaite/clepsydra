import { useState } from "react";
import { usePropertyCommit } from "#/api/bases";
import { usePage } from "#/api/pages";
import { DateCell } from "#/components/bases/cells/DateCell";
import type { CellValue } from "#/components/bases/cells/types";
import { Checkbox } from "#/components/ui/checkbox";
import {
  BIRTHDAY_KEY,
  type Birthday,
  birthdayPickerValue,
  birthdayValue,
  formatBirthday,
  readBirthday,
} from "#/lib/birthday";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { KindMetaExtrasProps } from "#/lib/kindPresentation";

/** The birthday editor's schema: the shared native date picker. */
const BIRTHDAY_DEFINITION = { type: "date" } as const;

const LABEL = "text-[13px] text-mute";

/** PERSON header band: the person's birthday. FOLIO renders it under the
 *  title/tags header (the kind's `headerExtras`), as MEETING does its facts.
 *
 *  `birthday` is stored in one of two forms: a native TOML date when the year
 *  is known, a plain `"MM-DD"` string when it is not. The picker always needs
 *  a full date, so a yearless birthday shows in it as year 2000 (a leap year,
 *  so Feb 29 is pickable); "Year unknown" decides which form a commit
 *  writes. The display shows the birthday itself, never the stand-in year. */
export function PersonMeta({ path, isDraft }: KindMetaExtrasProps) {
  const { data: page } = usePage(path);
  const commit = usePropertyCommit();
  const [editing, setEditing] = useState(false);
  // Unticking "Year unknown" asks for a year: the picker opens, and nothing
  // is written until the user changes the date.
  const [askingYear, setAskingYear] = useState(false);
  // With no birthday stored yet, the checkbox only chooses the form the
  // first commit writes.
  const [newYearless, setNewYearless] = useState(false);
  const [saving, setSaving] = useState(false);

  // The server sends every frontmatter key in `meta`; the OpenAPI schema
  // names only the ones other screens read, so this one is read untyped.
  const meta: Record<string, unknown> | undefined = page?.meta;
  const stored = readBirthday(meta?.[BIRTHDAY_KEY]);
  const yearless = stored ? stored.year === null && !askingYear : newYearless;
  const disabled = isDraft || saving;

  const write = async (next: Birthday | null) => {
    if (!page) return;
    const { value, hint } = next
      ? birthdayValue(next)
      : { value: null, hint: undefined };
    setSaving(true);
    try {
      // The `date` hint keeps a full birthday a native TOML date.
      await commit(
        { id: page.meta.id, path: page.path },
        BIRTHDAY_KEY,
        value,
        hint,
      );
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    setEditing(false);
    setAskingYear(false);
  };

  const onCommit = (next: CellValue) => {
    const prompted = askingYear && stored ? birthdayPickerValue(stored) : null;
    close();
    if (next === null) {
      void write(null);
      return;
    }
    // Leaving the year prompt unchanged must not invent a birth year 2000.
    if (next === prompted) return;
    const picked = readBirthday(next);
    if (!picked) return;
    void write(yearless ? { ...picked, year: null } : picked);
  };

  const onYearUnknownChange = (checked: boolean) => {
    if (!stored) {
      setNewYearless(checked);
      return;
    }
    if (checked) {
      close();
      if (stored.year !== null) void write({ ...stored, year: null });
      return;
    }
    if (stored.year === null) {
      setAskingYear(true);
      setEditing(true);
    }
  };

  const text = stored ? formatBirthday(stored) : "";

  return (
    <section
      aria-label="Person details"
      data-testid="person-header"
      className="mb-3 grid grid-cols-[92px_minmax(0,1fr)] items-start gap-x-4 gap-y-[18px]"
    >
      <div className={cn(LABEL, "pt-2")}>Birthday</div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0 max-w-[18rem] flex-1">
          {editing ? (
            <DateCell
              value={stored ? birthdayPickerValue(stored) : null}
              definition={BIRTHDAY_DEFINITION}
              ariaLabel="birthday"
              commitOnBlur
              onCommit={onCommit}
              onCommitNext={onCommit}
              onCancel={close}
            />
          ) : (
            <button
              type="button"
              aria-label="Edit birthday"
              disabled={disabled}
              className={cn(
                "block w-full cursor-text truncate rounded-md px-1 py-0.5 text-left",
                text === "" ? "text-faint" : "text-ink",
                "hover:bg-raise disabled:cursor-not-allowed disabled:hover:bg-transparent",
                FOCUS_RING_NATIVE,
              )}
              onClick={() => setEditing(true)}
            >
              {text === "" ? "—" : text}
            </button>
          )}
        </div>
        <Checkbox
          isSelected={yearless}
          isDisabled={disabled}
          onChange={onYearUnknownChange}
        >
          Year unknown
        </Checkbox>
      </div>
    </section>
  );
}

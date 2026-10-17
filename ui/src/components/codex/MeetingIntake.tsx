import { X } from "lucide-react";
import { useId } from "react";
import { PersonCombo } from "#/components/codex/PersonCombo";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type {
  KindIntakeDefinition,
  KindIntakeProps,
} from "#/lib/kindPresentation";
import { floorToQuarterHour, localIso, withSeconds } from "#/lib/meeting";

/** A meeting's intake owns its defaults, fields, and create-request projection. */
export const meetingIntake: KindIntakeDefinition = {
  initialValues: () => ({
    occurred_at: localIso(floorToQuarterHour(new Date())).slice(0, 16),
    attendees: [],
  }),
  Fields: MeetingIntakeFields,
  serialize: ({ attendees, occurred_at }) => ({
    ...(attendees?.length ? { attendees } : {}),
    ...(occurred_at ? { occurred_at: withSeconds(occurred_at) } : {}),
  }),
};

function MeetingIntakeFields({ value, onChange }: KindIntakeProps) {
  const attendeesLabelId = useId();
  const attendees = value.attendees ?? [];
  const setAttendees = (next: string[]) =>
    onChange({ ...value, attendees: next });
  const add = (name: string) => {
    if (
      attendees.some(
        (attendee) => attendee.toLowerCase() === name.toLowerCase(),
      )
    )
      return;
    setAttendees([...attendees, name]);
  };

  return (
    <>
      <div className="flex min-w-0 flex-col gap-1.5">
        <span className="text-[13px] text-mute">When</span>
        <input
          type="datetime-local"
          aria-label="When"
          value={value.occurred_at ?? ""}
          onChange={(event) =>
            onChange({ ...value, occurred_at: event.target.value })
          }
          className={cn(
            "h-8 w-full max-w-[16rem] rounded-lg bg-sink px-2.5 text-[13.5px] text-ink",
            FOCUS_RING_NATIVE,
          )}
        />
      </div>
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
                    setAttendees(
                      attendees.filter((entry) => entry !== attendee),
                    )
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
        <div className="flex min-w-[8ch] flex-1">
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

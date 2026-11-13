import { useMeetingHistory } from "#/api/meetingHistory";
import { useOutlinks } from "#/api/outlinks";
import { usePage } from "#/api/pages";
import { CLink } from "#/components/codex/CLink";
import { Section } from "#/components/codex/Section";
import { attendeeTarget, readAttendees } from "#/lib/attendance";
import { formatAbsoluteDate } from "#/lib/time";

/** Mounted only for saved plaintext 1:1 meetings by Folio. */
export function MeetingHistory({ path }: { path: string }) {
  const page = usePage(path);
  const attendees = readAttendees(page.data?.meta.attendees);
  const outlinks = useOutlinks(attendees.length === 1 ? path : "");
  const target =
    attendees.length === 1 && outlinks.isSuccess
      ? (outlinks.data.find(
          (link) =>
            link.source_field === "attendees" &&
            attendeeTarget(link.target_raw) === attendees[0] &&
            link.target_id,
        )?.target_id ?? attendees[0])
      : null;
  const history = useMeetingHistory(path, target ?? null);

  if (attendees.length !== 1) return null;

  const error = outlinks.error || history.error;
  const loading = !outlinks.isSuccess || history.isPending;
  return (
    <Section compact pip="dim" label="1:1 meetings">
      {error ? (
        <p className="m-0 text-[13px] text-mute" role="status">
          Could not load 1:1 meetings.
        </p>
      ) : loading ? (
        <p className="m-0 text-[13px] text-mute">Loading 1:1 meetings…</p>
      ) : history.data?.length ? (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {history.data.map((meeting) => {
            const occurredAt = meeting.columns.occurred_at;
            return (
              <li key={meeting.id}>
                <CLink
                  path={meeting.path}
                  className="cl-link-plain flex flex-col gap-1.5 rounded"
                >
                  <span className="font-serif text-[21px] leading-[1.2] text-ink">
                    {meeting.title || meeting.path}
                  </span>
                  {typeof occurredAt === "string" ? (
                    <time dateTime={occurredAt} className="text-[13px] text-mute">
                      {formatAbsoluteDate(
                        /^\d{4}-\d{2}-\d{2}$/.test(occurredAt)
                          ? `${occurredAt}T00:00:00`
                          : occurredAt,
                      )}
                    </time>
                  ) : null}
                </CLink>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 text-[13px] text-mute">No other 1:1 meetings yet.</p>
      )}
    </Section>
  );
}

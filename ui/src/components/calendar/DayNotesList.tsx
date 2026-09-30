import { CalendarDays } from "lucide-react";
import { CLink } from "#/components/codex/CLink";
import { KindIcon } from "#/components/KindIcon";
import { Button } from "#/components/ui/button";
import { type CalendarEntryLike, groupByKind } from "#/lib/calendar/bucket";
import type { DateKey } from "#/lib/calendar/dates";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { KIND_META, kindDisplayLabel } from "#/lib/kind";
import { parseLocalDate } from "#/lib/time";

export interface DayNotesListProps {
  dateKey: DateKey;
  entries: readonly CalendarEntryLike[];
  /** The day's journal, when one is written. */
  journalPath?: string | null;
  onOpenJournal: () => void;
  headingLevel?: 3 | 4;
  className?: string;
}

function longDate(key: DateKey): string {
  return parseLocalDate(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/** One day's pages, grouped by kind, plus the day's journal action. */
export function DayNotesList({
  dateKey,
  entries,
  journalPath,
  onOpenJournal,
  headingLevel = 3,
  className,
}: DayNotesListProps) {
  const Heading = `h${headingLevel}` as const;
  const groups = groupByKind(entries);
  return (
    <div className={cn("flex min-w-0 flex-col gap-4", className)}>
      <Heading className="m-0 font-serif text-[20px] italic leading-tight text-ink">
        {longDate(dateKey)}
      </Heading>
      {groups.length === 0 ? (
        <p className="m-0 text-[13px] text-mute">Nothing created this day.</p>
      ) : (
        <div className="flex flex-col gap-4">
          {groups.map(({ kind, entries: group }) => {
            const label = kindDisplayLabel(kind);
            return (
              <div key={kind} className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center gap-2 text-[12px] text-mute">
                  <span
                    data-kind-dot
                    aria-hidden="true"
                    className="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                    style={{ background: KIND_META[kind].color }}
                  />
                  <span>{label}</span>
                  <span className="text-faint">{group.length}</span>
                </div>
                <ul
                  aria-label={label}
                  className="m-0 flex list-none flex-col gap-2 p-0"
                >
                  {group.map((e) => (
                    <li key={e.path} className="min-w-0">
                      <CLink
                        path={e.path}
                        className={cn(
                          "cl-link-plain flex min-w-0 items-center gap-2 rounded text-[14px] text-ink-2 hover:text-ink",
                          FOCUS_RING_NATIVE,
                        )}
                      >
                        <KindIcon
                          kind={e.kind}
                          tone="mono"
                          className="flex-shrink-0"
                        />
                        <span className="truncate" title={e.path}>
                          {e.title || e.path}
                        </span>
                      </CLink>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}
      <div>
        <Button variant="secondary" size="sm" onPress={onOpenJournal}>
          <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
          {journalPath ? "Open journal · written" : "Open journal"}
        </Button>
      </div>
    </div>
  );
}

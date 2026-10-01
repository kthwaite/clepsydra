import { Cake, ChevronDown, ChevronUp, ListFilter } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Dialog, type Selection } from "react-aria-components";
import { useCalendarEntries } from "#/api/calendar";
import { DayNotesList } from "#/components/calendar/DayNotesList";
import { MonthCalendar } from "#/components/calendar/MonthCalendar";
import { Section } from "#/components/codex/Section";
import { IconButton } from "#/components/ui/icon-button";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
} from "#/components/ui/menu";
import { Popover } from "#/components/ui/popover";
import { useOpenJournalForDate } from "#/hooks/useOpenJournalForDate";
import {
  type BirthdayEntry,
  type BirthdayOccurrence,
  birthdayOccurrences,
} from "#/lib/birthday";
import { bucketEntries, type CalendarEntryLike } from "#/lib/calendar/bucket";
import { type DateKey, monthGridRange, rangeKeys } from "#/lib/calendar/dates";
import {
  readCollapsed,
  readHiddenKinds,
  readHideBirthdays,
  writeCollapsed,
  writeHiddenKinds,
  writeHideBirthdays,
} from "#/lib/calendar/railPrefs";
import { aiJournalDateFromPath, journalDateFromPath } from "#/lib/journal";
import {
  KIND_META,
  KINDS,
  type Kind,
  kindDisplayLabel,
  sortKindsByLabel,
} from "#/lib/kind";
import { localDateKey, parseLocalDate } from "#/lib/time";

export interface FolioCalendarSectionProps {
  path: string;
  kind: string | null;
  createdAt: string | null;
}

const MENU_KINDS = sortKindsByLabel(KINDS);
const NO_ENTRIES: readonly CalendarEntryLike[] = [];
const NO_BIRTHDAYS: readonly BirthdayEntry[] = [];
const NO_OCCURRENCES: readonly BirthdayOccurrence[] = [];
const NO_BIRTHDAY_DAYS: ReadonlyMap<DateKey, readonly BirthdayOccurrence[]> =
  new Map();
/** The Birthdays toggle's menu key; kinds are upper case, so no clash. */
const BIRTHDAYS_KEY = "birthdays";

/** The open page's calendar day: a journal's date from its path, else the
 *  local date of created_at. */
function pageDateOf(path: string, createdAt: string | null): DateKey | null {
  const fromPath = journalDateFromPath(path) ?? aiJournalDateFromPath(path);
  if (fromPath) return fromPath;
  if (!createdAt) return null;
  const created = new Date(createdAt);
  return Number.isNaN(created.getTime()) ? null : localDateKey(created);
}

function longDate(key: DateKey): string {
  return parseLocalDate(key).toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function ymOf(key: DateKey): [number, number] {
  const [y, m] = key.split("-").map(Number);
  return [y, m - 1];
}

/** Folio right-rail month calendar: follows the open page, filters kinds and
 *  birthdays on the client, and lists a day's notes in a popover. Desktop
 *  only. */
export function FolioCalendarSection({
  path,
  createdAt,
}: FolioCalendarSectionProps) {
  const today = localDateKey(new Date());
  const pageDate = pageDateOf(path, createdAt);

  const [visibleMonth, setVisibleMonth] = useState<DateKey>(pageDate ?? today);
  const [activeDay, setActiveDay] = useState<DateKey | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<Kind>>(readHiddenKinds);
  const [hideBirthdays, setHideBirthdays] =
    useState<boolean>(readHideBirthdays);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const anchorRef = useRef<HTMLElement | null>(null);
  const bodyId = useId();
  const openJournal = useOpenJournalForDate();

  // Follow the page: a new page, or the first date for this page (a late
  // created_at), re-anchors the month and closes any open day. Later date
  // changes on the same page (a refetch) keep manual paging.
  const [anchor, setAnchor] = useState({ path, pageDate });
  if (anchor.path !== path || (anchor.pageDate === null && pageDate !== null)) {
    setAnchor({ path, pageDate });
    setVisibleMonth(pageDate ?? today);
    setActiveDay(null);
  }

  const range = useMemo(() => {
    const [y, m] = ymOf(visibleMonth);
    return monthGridRange(y, m);
  }, [visibleMonth]);
  const { data } = useCalendarEntries({ range }, { enabled: !collapsed });
  const byDay = useMemo(
    () => bucketEntries(data?.entries ?? [], rangeKeys(range), hiddenKinds),
    [data, range, hiddenKinds],
  );
  const birthdaysByDay = useMemo(
    () =>
      hideBirthdays
        ? NO_BIRTHDAY_DAYS
        : birthdayOccurrences(
            data?.birthdays ?? NO_BIRTHDAYS,
            rangeKeys(range),
          ),
    [data, range, hideBirthdays],
  );

  const visibleKeys = useMemo(() => {
    const keys = new Set<string>(MENU_KINDS.filter((k) => !hiddenKinds.has(k)));
    if (!hideBirthdays) keys.add(BIRTHDAYS_KEY);
    return keys;
  }, [hiddenKinds, hideBirthdays]);

  const changeVisible = (keys: Selection) => {
    const next = new Set(
      keys === "all" ? [] : MENU_KINDS.filter((k) => !keys.has(k)),
    );
    setHiddenKinds(next);
    writeHiddenKinds(next);
    const hide = keys !== "all" && !keys.has(BIRTHDAYS_KEY);
    setHideBirthdays(hide);
    writeHideBirthdays(hide);
  };

  const toggleCollapsed = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(next);
    if (next) setActiveDay(null);
  };

  const activeEntries = activeDay
    ? (byDay.get(activeDay) ?? NO_ENTRIES)
    : NO_ENTRIES;
  const activeBirthdays = activeDay
    ? (birthdaysByDay.get(activeDay) ?? NO_OCCURRENCES)
    : NO_OCCURRENCES;
  const journalPath = activeEntries.find((e) => e.kind === "JOURNAL")?.path;

  // CLink opens the tab itself; any link click inside the day list also
  // closes the popover.
  const closeOnLink = (e: ReactMouseEvent) => {
    if ((e.target as Element).closest("a")) setActiveDay(null);
  };

  const action = (
    <>
      <MenuTrigger>
        <IconButton aria-label="Calendar kinds">
          <ListFilter aria-hidden="true" />
        </IconButton>
        <Menu
          aria-label="Calendar kinds"
          selectionMode="multiple"
          selectedKeys={visibleKeys}
          onSelectionChange={changeVisible}
          className="max-h-[min(420px,70vh)]"
        >
          <MenuItem id={BIRTHDAYS_KEY} icon={<Cake className="text-accent" />}>
            Birthdays
          </MenuItem>
          <MenuSeparator />
          {MENU_KINDS.map((k) => (
            <MenuItem key={k} id={k} swatch={KIND_META[k].color}>
              {kindDisplayLabel(k)}
            </MenuItem>
          ))}
        </Menu>
      </MenuTrigger>
      <IconButton
        aria-label={collapsed ? "Expand calendar" : "Collapse calendar"}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        onPress={toggleCollapsed}
      >
        {collapsed ? (
          <ChevronDown aria-hidden="true" />
        ) : (
          <ChevronUp aria-hidden="true" />
        )}
      </IconButton>
      {/* Room for the rail's absolute "Hide right sidebar" button, which
          sits on this header row. */}
      <span aria-hidden="true" className="w-8 shrink-0" />
    </>
  );

  return (
    <Section
      compact
      label="Calendar"
      caption={data?.truncated ? "5000+" : undefined}
      action={action}
    >
      <div id={bodyId} hidden={collapsed}>
        {!collapsed && (
          <MonthCalendar
            variant="rail"
            visibleMonth={visibleMonth}
            onVisibleMonthChange={setVisibleMonth}
            byDay={byDay}
            birthdaysByDay={birthdaysByDay}
            today={today}
            selectedDate={pageDate}
            activeDate={activeDay}
            onDayActivate={(key, cell) => {
              anchorRef.current = cell;
              setActiveDay(key);
            }}
          />
        )}
      </div>
      <Popover
        triggerRef={anchorRef}
        isOpen={activeDay !== null}
        onOpenChange={(open) => {
          if (!open) setActiveDay(null);
        }}
        placement="left top"
        className="w-[320px] max-w-[calc(100vw-32px)] overflow-auto rounded-[16px] bg-raise p-4 shadow-lg outline-none"
      >
        {activeDay && (
          <Dialog aria-label={longDate(activeDay)} className="outline-none">
            <div onClickCapture={closeOnLink}>
              <DayNotesList
                dateKey={activeDay}
                entries={activeEntries}
                birthdays={activeBirthdays}
                journalPath={journalPath ?? null}
                headingLevel={4}
                onOpenJournal={() => {
                  const day = activeDay;
                  setActiveDay(null);
                  void openJournal(day, journalPath);
                }}
              />
            </div>
          </Dialog>
        )}
      </Popover>
    </Section>
  );
}

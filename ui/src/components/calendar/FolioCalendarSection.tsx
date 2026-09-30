import { ChevronDown, ChevronUp, ListFilter } from "lucide-react";
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
import { Menu, MenuItem, MenuTrigger } from "#/components/ui/menu";
import { Popover } from "#/components/ui/popover";
import { useOpenJournalForDate } from "#/hooks/useOpenJournalForDate";
import { bucketEntries, type CalendarEntryLike } from "#/lib/calendar/bucket";
import { type DateKey, monthGridRange, rangeKeys } from "#/lib/calendar/dates";
import {
  readCollapsed,
  readHiddenKinds,
  writeCollapsed,
  writeHiddenKinds,
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

/** Folio right-rail month calendar: follows the open page, filters kinds on
 *  the client, and lists a day's notes in a popover. Desktop only. */
export function FolioCalendarSection({
  path,
  createdAt,
}: FolioCalendarSectionProps) {
  const today = localDateKey(new Date());
  const pageDate = pageDateOf(path, createdAt);
  const anchorKey = `${path}\u0000${pageDate ?? ""}`;

  const [visibleMonth, setVisibleMonth] = useState<DateKey>(pageDate ?? today);
  const [activeDay, setActiveDay] = useState<DateKey | null>(null);
  const [hiddenKinds, setHiddenKinds] = useState<Set<Kind>>(readHiddenKinds);
  const [collapsed, setCollapsed] = useState<boolean>(readCollapsed);
  const anchorRef = useRef<HTMLElement | null>(null);
  const bodyId = useId();
  const openJournal = useOpenJournalForDate();

  // Follow the page: a new page (or its created_at arriving) re-anchors the
  // month and closes any open day.
  const [anchoredTo, setAnchoredTo] = useState(anchorKey);
  if (anchoredTo !== anchorKey) {
    setAnchoredTo(anchorKey);
    setVisibleMonth(pageDate ?? today);
    setActiveDay(null);
  }

  const range = useMemo(() => {
    const [y, m] = ymOf(visibleMonth);
    return monthGridRange(y, m);
  }, [visibleMonth]);
  const { data } = useCalendarEntries({ range });
  const byDay = useMemo(
    () => bucketEntries(data?.entries ?? [], rangeKeys(range), hiddenKinds),
    [data, range, hiddenKinds],
  );

  const visibleKinds = useMemo(
    () => new Set(MENU_KINDS.filter((k) => !hiddenKinds.has(k))),
    [hiddenKinds],
  );

  const changeKinds = (keys: Selection) => {
    const next = new Set(
      keys === "all" ? [] : MENU_KINDS.filter((k) => !keys.has(k)),
    );
    setHiddenKinds(next);
    writeHiddenKinds(next);
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
          selectedKeys={visibleKinds}
          onSelectionChange={changeKinds}
          className="max-h-[min(420px,70vh)]"
        >
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

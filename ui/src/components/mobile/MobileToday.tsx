import { useNavigate } from "@tanstack/react-router";
import { useJournalToday } from "#/api/journal";
import { useAgenda } from "#/api/tasks";
import { greeting } from "#/components/codex/atrium-data";
import { useAtriumCalendar } from "#/components/codex/atrium-time";
import { useReadingRows } from "#/components/codex/ReadingContinues";
import {
  AgendaRow,
  Eyebrow,
  EyebrowAction,
} from "#/components/mobile/MobileParts";
import { agendaItemKey, journalExcerpt } from "#/components/mobile/mobile-data";
import { useClock } from "#/hooks/useClock";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { localDateKey } from "#/lib/time";
import { useUiStore } from "#/store/ui";

const DUE_LIMIT = 5;

/** "Good morning" → "Good" + accented "morning." (spec: one italic word). */
function Greeting({ text }: { text: string }) {
  const words = text.replace(/[.!?]+$/, "").split(" ");
  const last = words.pop() ?? "";
  const end = /[!?]$/.test(text) ? text.match(/[!?]+$/)?.[0] : ".";
  return (
    <h1 className="font-serif text-[48px] leading-none tracking-[-0.02em] text-ink">
      {words.length > 0 && `${words.join(" ")} `}
      <em className="font-serif italic text-accent">{`${last}${end}`}</em>
    </h1>
  );
}

function readingMeta(row: {
  progress?: number | null;
  pages?: number | null;
  author?: string | null;
}): string {
  if (row.progress != null && row.pages)
    return `p. ${row.progress} of ${row.pages}`;
  if (row.progress != null) return `p. ${row.progress}`;
  return row.author ?? "";
}

/** Mobile Today (spec §9 Q3; user ruling: the mocked sections only). */
export function MobileToday() {
  const now = useClock();
  const today = localDateKey(now);
  const calendar = useAtriumCalendar(now);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openJournal = useOpenTodayJournal();
  const openTab = useOpenTab();
  const navigate = useNavigate();
  const { data: journal } = useJournalToday();
  const { data: agenda } = useAgenda(today);
  const reading = useReadingRows();

  const longDate = `${now.toLocaleDateString("en-GB", { weekday: "long" })} ${now.getDate()} ${now.toLocaleDateString("en-GB", { month: "long" })}`;
  const excerpt = journal?.body ? journalExcerpt(journal.body) : null;
  const due = [...(agenda?.overdue ?? []), ...(agenda?.today ?? [])].slice(
    0,
    DUE_LIMIT,
  );

  return (
    <div className="flex flex-col gap-8 px-5 pt-5 pb-10">
      <div>
        <div className="text-[13px] text-mute">
          {`${longDate} · Week ${calendar.week}`}
        </div>
        <div className="mt-2">
          <Greeting text={greeting(now)} />
        </div>
      </div>

      <button
        type="button"
        onClick={openInscribe}
        className={cn(
          "flex h-[52px] items-center gap-2.5 rounded-full bg-sink pr-2 pl-[18px] text-left text-[15px] text-mute",
          FOCUS_RING_NATIVE,
        )}
      >
        <span className="flex-1">Capture a thought…</span>
        <span
          aria-hidden
          className="flex h-9 w-9 items-center justify-center rounded-full bg-accent text-[20px] text-raise"
        >
          +
        </span>
      </button>

      <section className="flex flex-col gap-3">
        <Eyebrow
          label="Journal"
          action={
            <EyebrowAction label="Open journal" onPress={openJournal}>
              Open →
            </EyebrowAction>
          }
        />
        <p
          className={cn(
            "ml-[17px] text-[15.5px] leading-[1.6]",
            excerpt ? "text-ink-2" : "text-mute",
          )}
        >
          {excerpt ?? "Nothing written yet."}
        </p>
      </section>

      <section className="flex flex-col gap-3.5">
        <Eyebrow
          label="Due today"
          action={
            <EyebrowAction
              label="Open agenda"
              onPress={() => void navigate({ to: "/agenda" })}
            >
              Agenda →
            </EyebrowAction>
          }
        />
        {due.length === 0 ? (
          <p className="ml-[17px] text-[15.5px] text-mute">Nothing due.</p>
        ) : (
          due.map((item) => (
            <AgendaRow key={agendaItemKey(item)} item={item} today={today} />
          ))
        )}
      </section>

      {reading.length > 0 && (
        <section className="flex flex-col gap-3.5">
          <Eyebrow label="Continue reading" />
          {reading.map((row) => (
            <button
              key={row.id}
              type="button"
              onClick={() => openTab("page", row.path, row.title ?? row.path)}
              className={cn(
                "ml-[17px] flex flex-col gap-[3px] rounded-md text-left",
                FOCUS_RING_NATIVE,
              )}
            >
              <span className="font-serif text-[22px] leading-[1.15] text-ink">
                {row.title ?? row.path}
              </span>
              <span className="text-[12.5px] text-mute">
                {readingMeta(row)}
              </span>
            </button>
          ))}
        </section>
      )}
    </div>
  );
}

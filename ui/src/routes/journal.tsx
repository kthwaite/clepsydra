import { createFileRoute } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { type FormEvent, useCallback, useMemo, useState } from "react";
import { useBacklinks } from "#/api/index";
import {
  useJournalByDate,
  useJournalRecent,
  useJournalToday,
  useQuickCapture,
} from "#/api/journal";
import { BacklinksPanel } from "#/components/BacklinksPanel";
import { Button } from "#/components/ui/button";
import { IconButton } from "#/components/ui/icon-button";
import { PageEditorHeader } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor } from "#/editor/SlateEditor";
import { usePageEditor } from "#/editor/usePageEditor";

export const Route = createFileRoute("/journal")({
  component: JournalPage,
});

/** Format a Date as YYYY-MM-DD. */
function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Parse YYYY-MM-DD into a local Date. */
function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Shift a YYYY-MM-DD string by `delta` days. */
function shiftDate(dateStr: string, delta: number): string {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + delta);
  return fmtDate(d);
}

/** Human-readable date label. */
function dateLabel(dateStr: string): string {
  const today = fmtDate(new Date());
  if (dateStr === today) return "Today";

  const yesterday = shiftDate(today, -1);
  if (dateStr === yesterday) return "Yesterday";

  const tomorrow = shiftDate(today, 1);
  if (dateStr === tomorrow) return "Tomorrow";

  const d = parseDate(dateStr);
  return d.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

function JournalPage() {
  const today = useMemo(() => fmtDate(new Date()), []);
  const [selectedDate, setSelectedDate] = useState(today);

  // Fetch journal metadata to confirm existence / auto-create today
  const isToday = selectedDate === today;
  const todayQuery = useJournalToday();
  const dateQuery = useJournalByDate(isToday ? "" : selectedDate);

  const journal = isToday ? todayQuery.data : dateQuery.data;
  const isLoading = isToday ? todayQuery.isLoading : dateQuery.isLoading;
  const fetchError = isToday ? todayQuery.error : dateQuery.error;

  // Once we have a journal path, plug into the full page editor
  const journalPath = journal?.path ?? "";
  const editor = usePageEditor(journalPath);
  const { data: backlinks } = useBacklinks(journalPath);

  // Recent journals for sidebar
  const { data: recentJournals } = useJournalRecent(14);

  // Quick capture
  const capture = useQuickCapture();
  const [captureText, setCaptureText] = useState("");

  const handleCapture = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const text = captureText.trim();
      if (!text) return;
      capture.mutate(text, {
        onSuccess: () => setCaptureText(""),
      });
    },
    [captureText, capture],
  );

  const goToPrevDay = useCallback(() => {
    setSelectedDate((d) => shiftDate(d, -1));
  }, []);

  const goToNextDay = useCallback(() => {
    setSelectedDate((d) => shiftDate(d, 1));
  }, []);

  const goToToday = useCallback(() => {
    setSelectedDate(fmtDate(new Date()));
  }, []);

  // Loading state
  if (isLoading) {
    return <div className="p-8 text-muted-foreground">Loading journal...</div>;
  }

  // Error / not-found for non-today dates
  if (fetchError && !isToday) {
    return (
      <div className="flex h-full flex-col">
        <JournalNav
          date={selectedDate}
          onPrev={goToPrevDay}
          onNext={goToNextDay}
          onToday={goToToday}
        />
        <div className="flex-1 p-8 text-muted-foreground">
          No journal entry for {selectedDate}.
        </div>
        <QuickCaptureBar
          value={captureText}
          onChange={setCaptureText}
          onSubmit={handleCapture}
          isPending={capture.isPending}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <JournalNav
        date={selectedDate}
        onPrev={goToPrevDay}
        onNext={goToNextDay}
        onToday={goToToday}
      />

      <div className="flex flex-1 overflow-hidden">
        {/* Main editor area */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-8 py-6">
            {journalPath && !editor.isLoading && !editor.error && (
              <>
                <div className="mb-2 flex items-center justify-end">
                  <SaveIndicator
                    status={editor.saveStatus}
                    error={editor.saveError}
                  />
                </div>

                <PageEditorHeader
                  path={journalPath}
                  title={editor.title}
                  onTitleChange={editor.setTitle}
                  tags={editor.tags}
                  onTagsChange={editor.setTags}
                  aliases={editor.aliases}
                  onAliasesChange={editor.setAliases}
                />

                <article className="mt-6">
                  <SlateEditor
                    key={journalPath}
                    initialValue={editor.initialValue}
                    onChange={editor.onSlateChange}
                    onSaveNow={editor.saveNow}
                  />
                </article>

                {backlinks && backlinks.length > 0 && (
                  <BacklinksPanel backlinks={backlinks} />
                )}
              </>
            )}
            {editor.isLoading && (
              <div className="text-muted-foreground">Loading editor...</div>
            )}
            {!!editor.error && (
              <div className="text-destructive">
                Failed to load journal page.
              </div>
            )}
          </div>
        </div>

        {/* Recent journals sidebar */}
        {recentJournals && recentJournals.length > 0 && (
          <aside className="hidden w-56 shrink-0 overflow-y-auto border-l border-border px-3 py-4 lg:block">
            <h2 className="mb-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Recent
            </h2>
            <ul className="space-y-px">
              {recentJournals.map((j) => (
                <li key={j.journal_date}>
                  <button
                    type="button"
                    onClick={() => setSelectedDate(j.journal_date)}
                    className={`block w-full px-2 py-1 text-left text-xs hover:bg-accent ${
                      j.journal_date === selectedDate
                        ? "bg-accent font-bold text-foreground"
                        : "text-muted-foreground"
                    }`}
                  >
                    {j.journal_date}
                    {j.title && j.title !== j.journal_date && (
                      <span className="ml-1 text-muted-foreground">
                        {j.title}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      <QuickCaptureBar
        value={captureText}
        onChange={setCaptureText}
        onSubmit={handleCapture}
        isPending={capture.isPending}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function JournalNav({
  date,
  onPrev,
  onNext,
  onToday,
}: {
  date: string;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
}) {
  const isToday = date === fmtDate(new Date());

  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-2">
      <IconButton
        variant="secondary"
        onPress={onPrev}
        aria-label="Previous day"
      >
        <ChevronLeft />
      </IconButton>
      <IconButton variant="secondary" onPress={onNext} aria-label="Next day">
        <ChevronRight />
      </IconButton>

      <h1 className="font-heading text-lg font-bold">
        {dateLabel(date)}
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {date}
        </span>
      </h1>

      {!isToday && (
        <Button
          variant="secondary"
          size="sm"
          onPress={onToday}
          className="ml-auto"
        >
          Today
        </Button>
      )}
    </div>
  );
}

function QuickCaptureBar({
  value,
  onChange,
  onSubmit,
  isPending,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: FormEvent) => void;
  isPending: boolean;
}) {
  return (
    <div className="border-t border-border px-4 py-3">
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Quick capture to today's journal..."
          disabled={isPending}
          className="flex-1 border border-border bg-background px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus:border-ring disabled:cursor-not-allowed disabled:opacity-50"
        />
        <Button
          variant="primary"
          type="submit"
          isDisabled={isPending || !value.trim()}
        >
          {isPending ? "Saving..." : "Capture"}
        </Button>
      </form>
    </div>
  );
}

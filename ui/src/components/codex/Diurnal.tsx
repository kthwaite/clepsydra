import { type FormEvent, useCallback, useMemo, useState } from "react";
import { useBacklinks } from "#/api/index";
import {
  useJournalByDate,
  useJournalRecent,
  useJournalToday,
  useQuickCapture,
} from "#/api/journal";
import { ASCII_QUILL } from "#/components/codex/ascii";
import { CLink } from "#/components/codex/CLink";
import { shortFolio } from "#/components/codex/folio-utils";
import { PageEditorHeader } from "#/editor/PageEditorHeader";
import { SaveIndicator } from "#/editor/SaveIndicator";
import { SlateEditor } from "#/editor/SlateEditor";
import { usePageEditor } from "#/editor/usePageEditor";

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function shiftDate(s: string, delta: number): string {
  const d = parseDate(s);
  d.setDate(d.getDate() + delta);
  return fmtDate(d);
}

const ROMAN_MONTH = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII"];

function romanDate(s: string): string {
  const d = parseDate(s);
  return `${d.getDate()} ${ROMAN_MONTH[d.getMonth()]}`;
}

export function Diurnal() {
  const today = useMemo(() => fmtDate(new Date()), []);
  const [selectedDate, setSelectedDate] = useState(today);

  const isToday = selectedDate === today;
  const todayQuery = useJournalToday();
  const dateQuery = useJournalByDate(isToday ? "" : selectedDate);
  const journal = isToday ? todayQuery.data : dateQuery.data;
  const isLoading = isToday ? todayQuery.isLoading : dateQuery.isLoading;
  const fetchError = isToday ? todayQuery.error : dateQuery.error;

  const journalPath = journal?.path ?? "";
  const editor = usePageEditor(journalPath);
  const { data: backlinks } = useBacklinks(journalPath);
  const { data: recentJournals } = useJournalRecent(14);

  const capture = useQuickCapture();
  const [captureText, setCaptureText] = useState("");

  const handleCapture = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const text = captureText.trim();
      if (!text) return;
      capture.mutate(text, { onSuccess: () => setCaptureText("") });
    },
    [captureText, capture],
  );

  const goPrev = useCallback(() => setSelectedDate((d) => shiftDate(d, -1)), []);
  const goNext = useCallback(() => setSelectedDate((d) => shiftDate(d, 1)), []);
  const goToday = useCallback(() => setSelectedDate(fmtDate(new Date())), []);

  const dayLabel = useMemo(() => {
    const d = parseDate(selectedDate);
    return d.toLocaleDateString(undefined, {
      weekday: "long",
      day: "numeric",
      month: "long",
    });
  }, [selectedDate]);

  return (
    <div className="grid h-full grid-cols-[180px_1fr_220px] gap-[18px] px-5 py-[18px]">
      {/* L: FASTI timeline */}
      <div>
        <div className="cl-cap mb-1 text-[9px] text-ink-mute">
          FASTI · {romanLower(recentJournals?.length ?? 0)}
        </div>
        <hr className="cl-rule" />
        <div className="mt-2 flex gap-1">
          <button type="button" className="cl-btn" onClick={goPrev}>
            ‹
          </button>
          <button type="button" className="cl-btn" onClick={goToday}>
            Today
          </button>
          <button type="button" className="cl-btn" onClick={goNext}>
            ›
          </button>
        </div>
        <div className="mt-2 border-l border-rule pl-2">
          {(recentJournals ?? []).slice(0, 14).map((j, i) => {
            const dateStr = j.journal_date ?? "";
            const active = dateStr === selectedDate;
            const marker = j.path ? "◉" : "◌";
            return (
              <button
                key={dateStr || i}
                type="button"
                onClick={() => dateStr && setSelectedDate(dateStr)}
                className={`mb-[2px] grid w-full cursor-pointer grid-cols-[auto_1fr_auto] items-baseline gap-[6px] border-none bg-transparent p-0 text-left text-[10px] ${
                  active ? "text-ink" : "text-ink-mute"
                }`}
              >
                <span className="cl-mono text-accent">{marker}</span>
                <span
                  className={`cl-serif ${active ? "font-semibold not-italic" : "italic"}`}
                >
                  {dateStr ? romanDate(dateStr) : "—"}
                </span>
                <span className="cl-mono text-[9px]">
                  {dateStr ? relativeDays(dateStr, today) : ""}
                </span>
              </button>
            );
          })}
        </div>
        <div className="cl-marg mt-3">◉ written · ◌ skipped</div>
      </div>

      {/* CENTER: page */}
      <div>
        <div className="mb-1 flex items-baseline justify-between">
          <div className="cl-cap cl-cap-wide text-[14px]">DIURNAL</div>
          <div className="cl-mono text-[10px] text-ink-mute">
            {journalPath ? `D · ${shortFolio(journalPath)}` : "D · —"}
          </div>
        </div>
        <div className="mb-3 flex items-baseline justify-between border-b border-rule border-t-2 border-t-rule py-[5px]">
          <div className="cl-serif text-[28px] font-semibold leading-none">{dayLabel}</div>
          <div className="cl-mono text-[11px]">
            MMXXVI · day {dayOfYear(parseDate(selectedDate))}
          </div>
        </div>

        {isLoading && <div className="cl-marg py-[18px]">… fetching diurnal page …</div>}

        {!isLoading && fetchError && !isToday && (
          <div className="cl-marg py-[18px]">⁂ no entry for {selectedDate}.</div>
        )}

        {!isLoading && journalPath && !editor.isLoading && !editor.error && (
          <div>
            <div className="mb-1 flex items-center justify-end">
              <SaveIndicator status={editor.saveStatus} error={editor.saveError} />
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
            <article className="mt-4">
              <SlateEditor
                key={`${journalPath}:${editor.editorRevision}`}
                initialValue={editor.initialValue}
                onChange={editor.onSlateChange}
                onSaveNow={editor.saveNow}
              />
            </article>
            {backlinks && backlinks.length > 0 && (
              <>
                <hr className="cl-rule-soft my-4" />
                <div className="cl-cap mb-2 text-[10px]">↘ Backlinks · {backlinks.length}</div>
                <div>
                  {backlinks.map((b) => (
                    <div
                      key={b.source_path}
                      className="mb-[2px] grid grid-cols-[60px_1fr] text-[11px]"
                    >
                      <span className="cl-mono text-[9px] text-accent-deep">
                        {shortFolio(b.source_path)}
                      </span>
                      <CLink path={b.source_path} className="italic">
                        {b.source_title || b.source_path}
                      </CLink>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Quick capture */}
        <form onSubmit={handleCapture} className="mt-4 flex items-center gap-2">
          <span className="cl-mono text-[12px] text-accent">❦</span>
          <input
            value={captureText}
            onChange={(e) => setCaptureText(e.target.value)}
            placeholder="capture an aside …"
            className="cl-mono flex-1 border-b border-rule-soft bg-transparent px-1 py-1 text-[13px] outline-none"
          />
          <button
            type="submit"
            className="cl-btn"
            disabled={capture.isPending || !captureText.trim()}
          >
            Note
          </button>
        </form>
      </div>

      {/* R: marginalia */}
      <div className="border-l border-rule-soft pl-3">
        <div className="cl-cap mb-1 text-[9px]">§ Habits, this day</div>
        <hr className="cl-rule-soft" />
        {[
          ["Morning page", "◉◉◉◉◉ ◉◉◉○○"],
          ["Read · 30 min", "◉◉◉◉◉ ◉◉○○○"],
          ["Walk", "◉◉◉○○ ○○○○○"],
          ["No screens 22→", "◉◉◉◉◉ ◉◉◉◉◉"],
        ].map(([k, v]) => (
          <div key={k} className="mb-1">
            <div className="cl-serif text-[11px] italic">{k}</div>
            <div className="cl-mono text-[9px] tracking-[0.05em] text-accent-deep">{v}</div>
          </div>
        ))}

        <div className="cl-cap mb-1 mt-4 text-[9px]">§ Et cetera</div>
        <hr className="cl-rule-soft" />
        <p className="cl-marg mt-1">
          The window is fogged from the inside; the kettle has stopped twice; outside, a pigeon
          sits on the cable and does not move.
        </p>

        <pre className="cl-ascii cl-ascii-faint mt-4 text-center text-[6px]">{ASCII_QUILL}</pre>
        <p className="cl-marg mt-1 text-center text-[10px]">fig. iv · stylus</p>
      </div>
    </div>
  );
}

const LOWERS = ["i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii"];

function romanLower(n: number): string {
  if (n <= 0) return "—";
  if (n < 13) return LOWERS[n - 1] ?? "—";
  return String(n);
}

function relativeDays(dateStr: string, today: string): string {
  if (dateStr === today) return "today";
  const d1 = parseDate(today).getTime();
  const d2 = parseDate(dateStr).getTime();
  const diff = Math.round((d1 - d2) / (1000 * 60 * 60 * 24));
  if (diff > 0) return `${diff}d`;
  return "—";
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  const diff = d.getTime() - start.getTime();
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

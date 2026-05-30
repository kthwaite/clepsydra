import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useBcl } from "#/api/bcl";
import { useContentIndex, useStats, useTags } from "#/api/index";
import { useJournalToday } from "#/api/journal";
import { useClock } from "#/hooks/useClock";
import { useUiStore } from "#/store/ui";
import { Card } from "./Card";
import {
  buildHeatmap,
  dayOfYear,
  deriveInventory,
  julianDay,
} from "./atrium-data";

export function Atrium() {
  const navigate = useNavigate();
  const { data: tags } = useTags();
  const { data: stats } = useStats();
  const { data: content } = useContentIndex(500);
  const { data: bcl } = useBcl();

  const { data: journalToday } = useJournalToday();
  const openSearch = useUiStore((s) => s.openSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);

  const items = content?.items ?? [];
  const now = useClock();

  const todayLabel = `${fmtDate(now)} (${WEEKDAYS[now.getDay()]})`;
  const doy = dayOfYear(now);
  const yearDays = isLeap(now.getFullYear()) ? 366 : 365;
  const week = Math.ceil(doy / 7);
  const clock = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  const journalSub = journalToday?.meta.id
    ? `${journalToday.meta.id} · DAILY / ${fmtDate(now)}`
    : `DAILY / ${fmtDate(now)}`;

  const heat = useMemo(() => buildHeatmap(items, now), [items, now]);
  const topTags = useMemo(
    () => [...(tags ?? [])].sort((a, b) => b.count - a.count).slice(0, 8),
    [tags],
  );
  const maxTag = topTags[0]?.count ?? 1;

  const inventory = useMemo(
    () => deriveInventory(stats, tags, items, now),
    [stats, tags, items, now],
  );

  const skyTimes = useMemo(() => {
    return { sunrise: dfltTime(now, 6), sunset: dfltTime(now, 20) };
  }, [now]);

  const aphorism = APHORISMS[dayOfYear(now) % APHORISMS.length];

  return (
    <div className="mx-auto grid max-w-[1600px] auto-rows-min grid-cols-12 gap-3.5 px-4 py-4">
      {/* HERO — col-12 */}
      <section className="cl-grid-texture col-span-12 grid items-end gap-6 border border-rule bg-paper-2 px-6 py-5 md:grid-cols-[1fr_auto]">
        <div>
          <div className="cl-mono mb-3 flex flex-wrap items-center gap-4 text-[9px] uppercase tracking-[0.28em] text-ink-mute">
            <span className="text-accent">●</span>
            <span>DAYSTART / <b className="font-medium text-ink">{todayLabel}</b></span>
            <span>WEEK {week}</span>
            <span>DAY {doy} / {yearDays}</span>
            <span>JD {julianDay(now)}</span>
            <span className="tabular-nums">{clock} LOCAL</span>
          </div>
          <h1 className="font-sans text-[clamp(40px,6vw,72px)] font-black leading-[0.95] tracking-[-0.02em] text-ink">
            {greeting(now)}.
          </h1>
        </div>

        <div className="flex min-w-[280px] flex-col gap-2">
          <button
            type="button"
            onClick={() => navigate({ to: "/journal" })}
            className="group grid grid-cols-[1fr_auto] items-center gap-4 border border-ink bg-ink px-4 py-3.5 text-left text-paper transition-colors hover:border-accent hover:bg-accent"
          >
            <div>
              <div className="font-sans text-[12px] font-semibold uppercase tracking-[0.18em]">
                Open today’s journal
              </div>
              <div className="cl-mono mt-1 text-[9px] uppercase tracking-[0.18em] opacity-75">
                {journalSub}
              </div>
            </div>
            <div className="text-[16px]">→</div>
          </button>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={openInscribe}
              className="cl-mono border border-rule bg-paper px-2.5 py-2 text-left text-[9px] uppercase tracking-[0.22em] text-ink-2 hover:border-ink-mute hover:text-ink"
            >
              Capture
              <div className="mt-1 text-[9px] tracking-[0.18em] text-ink-mute">⌘ N</div>
            </button>
            <button
              type="button"
              onClick={openSearch}
              className="cl-mono border border-rule bg-paper px-2.5 py-2 text-left text-[9px] uppercase tracking-[0.22em] text-ink-2 hover:border-ink-mute hover:text-ink"
            >
              Search
              <div className="mt-1 text-[9px] tracking-[0.18em] text-ink-mute">⌘ K</div>
            </button>
          </div>
        </div>
      </section>

      {/* INVENTORY — col-12 */}
      <Card
        className="col-span-12"
        label="Vessel · Inventory"
        caption="FIG. I — STEADY-STATE TELEMETRY"
        tight
      >
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8">
          {inventory.map((cell, i) => (
            <div
              key={cell.label}
              className={
                "flex flex-col gap-1 border-rule px-3.5 py-3 " +
                (i % 8 !== 7 ? "border-r " : "") +
                (i >= 4 ? "border-t lg:border-t-0 " : "")
              }
            >
              <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
                {cell.label}
              </span>
              <span
                className={
                  "font-sans text-[28px] font-bold leading-none tabular-nums " +
                  (cell.tone === "warn" ? "text-warn" : "text-ink")
                }
              >
                {cell.value}
              </span>
              {cell.sub ? (
                <span className="cl-mono text-[9px] tracking-[0.12em] text-ink-mute">
                  {cell.sub}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      {/* APHORISM (col-7) + SKY (col-5) */}
      <Card className="col-span-12 lg:col-span-7" label="Aphorism" pip="dim" caption="FIG. II">
        <blockquote className="m-0 font-sans text-[18px] italic leading-[1.4] text-ink-2">
          “{aphorism.text}”
        </blockquote>
        <div className="cl-mono mt-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute">
          — {aphorism.who}
        </div>
      </Card>
      <Card className="col-span-12 lg:col-span-5" label="Sky" caption="FIG. III">
        {/* replaced in Task 11 */}
        <div className="cl-mono flex flex-col gap-1.5 text-[11px]">
          <KVLine k="Sunrise" v={fmtTime(skyTimes.sunrise)} />
          <KVLine k="Sunset" v={fmtTime(skyTimes.sunset)} />
        </div>
      </Card>

      {/* HEATMAP (col-8) + TAGS (col-4) */}
      <Card className="col-span-12 lg:col-span-8" label={`Activity · ${heat.total} edits / 26wk`} pip="cool" caption="FIG. IV — CAPTURES PER DAY">
        <Heatmap weeks={heat.weeks} />
      </Card>
      <Card className="col-span-12 lg:col-span-4" label="Subjects, by frequency" caption="FIG. V">
        {topTags.length === 0 ? (
          <p className="cl-marg m-0">No tags yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {topTags.map((t) => (
              <button
                type="button"
                key={t.tag}
                onClick={() =>
                  navigate({ to: "/gazetteer", search: { tag: t.tag } as never })
                }
                className="group grid cursor-pointer grid-cols-[120px_1fr_36px] items-center gap-2 text-left"
              >
                <span className="cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-ink-2 group-hover:text-accent">
                  #{t.tag}
                </span>
                <span className="h-[8px] bg-rule-soft">
                  <span
                    className="block h-full bg-accent"
                    style={{ width: `${Math.max(4, (t.count / maxTag) * 100)}%` }}
                  />
                </span>
                <span className="cl-mono text-right text-[10px] tabular-nums text-ink-mute">
                  {t.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>

      {/* RECENTS (col-7, filled in Task 13) + BCL (col-5) */}
      <div className="col-span-12 lg:col-span-7">{/* recents placeholder, replaced in Task 13 */}</div>
      {bcl?.birth_date && bcl.bcl_date && bcl.remaining_seconds !== null && (
        <Card className="col-span-12 lg:col-span-5" label="Brimley-Cocoon Line" pip="dim" caption="FIG. VII">
          <div className="cl-mono text-[22px] leading-none text-accent">
            {fmtBclDuration(bcl.remaining_seconds)}
          </div>
          <div className="cl-mono mt-1.5 text-[10px] text-ink-mute">
            {bcl.remaining_seconds >= 0 ? "crosses" : "crossed"}{" "}
            {fmtBclDate(bcl.bcl_date)} · natal {bcl.birth_date}
          </div>
        </Card>
      )}
    </div>
  );
}

/* ── presentational ───────────────────────────────────────────────────── */

function KVLine({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-[9px] uppercase tracking-[0.12em] text-ink-mute">
        {k}
      </span>
      <span className="text-ink-2">{v}</span>
    </div>
  );
}

const HEAT_LEVEL = [
  "bg-rule-soft",
  "bg-accent/25",
  "bg-accent/50",
  "bg-accent/75",
  "bg-accent",
];

function Heatmap({ weeks }: { weeks: number[][] }) {
  return (
    <div className="cl-noscroll flex gap-[3px] overflow-x-auto">
      {weeks.map((week, wi) => (
        <div key={`w${wi}`} className="flex flex-col gap-[3px]">
          {week.map((level, di) => (
            <span
              key={`d${di}`}
              className={`h-[10px] w-[10px] ${HEAT_LEVEL[level]}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ── data helpers ─────────────────────────────────────────────────────── */

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function isLeap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function greeting(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Still awake";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  if (h < 22) return "Good evening";
  return "Good night";
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

function dfltTime(now: Date, h: number): Date {
  const d = new Date(now);
  d.setHours(h, 0, 0, 0);
  return d;
}

function fmtTime(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

const APHORISMS: { text: string; who: string }[] = [
  {
    text: "Attention is the rarest and purest form of generosity.",
    who: "Simone Weil",
  },
  {
    text: "The smallest unit of memory is the willingness to return.",
    who: "—",
  },
  {
    text: "What is to give light must endure burning.",
    who: "Viktor Frankl",
  },
  {
    text: "We do not write in order to be understood; we write in order to understand.",
    who: "C. Day-Lewis",
  },
  {
    text: "The notebook is a net for catching days.",
    who: "Annie Dillard",
  },
  {
    text: "Order is not pressure imposed from without, but an equilibrium set up from within.",
    who: "José Ortega y Gasset",
  },
  {
    text: "A man should keep his little brain attic stocked with all the furniture that he is likely to use.",
    who: "Arthur Conan Doyle",
  },
];

function fmtBclDuration(totalSeconds: number): string {
  const past = totalSeconds < 0;
  const s = Math.abs(totalSeconds);
  const days = Math.floor(s / 86_400);
  const hours = Math.floor((s % 86_400) / 3_600);
  return `${past ? "+" : ""}${days.toLocaleString("en-US")}d · ${hours}h`;
}

function fmtBclDate(yyyymmdd: string): string {
  const [y, m, d] = yyyymmdd.split("-").map((p) => Number.parseInt(p, 10));
  if (!y || !m || !d) return yyyymmdd;
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

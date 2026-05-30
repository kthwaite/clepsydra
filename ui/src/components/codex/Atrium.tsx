import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useBcl } from "#/api/bcl";
import { useContentIndex, useTags } from "#/api/index";
import { useClock } from "#/hooks/useClock";
import { Card } from "./Card";
import { buildHeatmap, dayOfYear } from "./atrium-data";

export function Atrium() {
  const navigate = useNavigate();
  const { data: tags } = useTags();
  const { data: content } = useContentIndex(500);
  const { data: bcl } = useBcl();

  const items = content?.items ?? [];
  const now = useClock();

  const heat = useMemo(() => buildHeatmap(items, now), [items, now]);
  const topTags = useMemo(
    () => [...(tags ?? [])].sort((a, b) => b.count - a.count).slice(0, 8),
    [tags],
  );
  const maxTag = topTags[0]?.count ?? 1;

  const skyTimes = useMemo(() => {
    return { sunrise: dfltTime(now, 6), sunset: dfltTime(now, 20) };
  }, [now]);

  const aphorism = APHORISMS[dayOfYear(now) % APHORISMS.length];

  return (
    <div className="mx-auto grid max-w-[1600px] auto-rows-min grid-cols-12 gap-3.5 px-4 py-4">
      {/* HERO — col-12 (filled in Task 9) */}
      <div className="col-span-12">{/* hero placeholder, replaced in Task 9 */}</div>

      {/* INVENTORY — col-12 (filled in Task 10) */}
      <div className="col-span-12">{/* inventory placeholder, replaced in Task 10 */}</div>

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

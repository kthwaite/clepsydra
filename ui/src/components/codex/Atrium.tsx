import { useNavigate } from "@tanstack/react-router";
import { type ReactNode, useMemo, useState } from "react";
import SunCalc from "suncalc";
import { useBcl } from "#/api/bcl";
import { useContentIndex, useStats, useTags } from "#/api/index";
import { useLocation } from "#/api/location";
import { formatRelativeTime } from "#/components/codex/codex-time";
import { shortFolio } from "#/components/codex/folio-utils";
import { InscribeModal } from "#/components/codex/InscribeModal";
import { useOpenTab } from "#/hooks/useOpenTab";
import { kindColorVar, resolveKindFromPath } from "#/lib/kind";
import { useUiStore } from "#/store/ui";

export function Atrium() {
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const openSearch = useUiStore((s) => s.openSearch);
  const [inscribeOpen, setInscribeOpen] = useState(false);
  const { data: stats } = useStats();
  const { data: tags } = useTags();
  const { data: content } = useContentIndex(500);
  const { data: bcl } = useBcl();
  const { data: location } = useLocation();

  const items = content?.items ?? [];

  const recent = useMemo(
    () =>
      [...items]
        .sort(
          (a, b) =>
            (b.updated_at ? Date.parse(b.updated_at) : 0) -
            (a.updated_at ? Date.parse(a.updated_at) : 0),
        )
        .slice(0, 8),
    [items],
  );

  const heat = useMemo(() => buildHeatmap(items), [items]);
  const topTags = useMemo(
    () => [...(tags ?? [])].sort((a, b) => b.count - a.count).slice(0, 8),
    [tags],
  );
  const maxTag = topTags[0]?.count ?? 1;

  const now = new Date();
  const sky = buildSky(
    now,
    location?.latitude ?? null,
    location?.longitude ?? null,
    location?.label ?? null,
  );
  const aphorism = APHORISMS[dayOfYear(now) % APHORISMS.length];

  return (
    <div className="mx-auto flex max-w-[1140px] flex-col gap-5 px-6 py-6">
      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section className="cl-frame flex flex-col gap-4 px-6 py-5 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="font-sans text-[40px] font-black leading-[0.95] tracking-[-0.02em] text-ink">
            {greeting(now)}.
          </h1>
          <div className="cl-mono mt-2 text-[11px] uppercase tracking-[0.18em] text-ink-mute">
            {fmtDate(now)} · JD {julianDay(now)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="cl-btn"
            onClick={() => navigate({ to: "/journal" })}
          >
            Open Diurnal
          </button>
          <button
            type="button"
            className="cl-btn cl-btn-hot"
            onClick={() => setInscribeOpen(true)}
          >
            + Inscribe
          </button>
          <button type="button" className="cl-btn" onClick={openSearch}>
            Search ⌘K
          </button>
        </div>
      </section>

      {/* ── STAT GRID ────────────────────────────────────────────────── */}
      <section className="grid grid-cols-2 gap-px border border-rule bg-rule sm:grid-cols-3 lg:grid-cols-5">
        <Stat label="Notes" value={stats?.pages} />
        <Stat label="Links" value={stats?.links_total} />
        <Stat label="Unresolved" value={stats?.links_unresolved} tone="warn" />
        <Stat label="Tags" value={stats?.tags} />
        <Stat label="Attachments" value={stats?.attachments} />
      </section>

      {/* ── ACTIVITY + TAGS | SKY + APHORISM ─────────────────────────── */}
      <section className="grid gap-5 lg:grid-cols-[1.6fr_1fr]">
        <div className="flex flex-col gap-5">
          <Panel label={`Activity · ${heat.total} edits / 26wk`}>
            <Heatmap weeks={heat.weeks} />
          </Panel>
          <Panel label="Subjects, by frequency">
            {topTags.length === 0 ? (
              <p className="cl-marg m-0">No tags yet.</p>
            ) : (
              <div className="flex flex-col gap-1.5">
                {topTags.map((t) => (
                  <button
                    type="button"
                    key={t.tag}
                    onClick={() =>
                      navigate({
                        to: "/gazetteer",
                        search: { tag: t.tag } as never,
                      })
                    }
                    className="group grid cursor-pointer grid-cols-[120px_1fr_36px] items-center gap-2 text-left"
                  >
                    <span className="cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-ink-2 group-hover:text-accent">
                      #{t.tag}
                    </span>
                    <span className="h-[8px] bg-rule-soft">
                      <span
                        className="block h-full bg-accent"
                        style={{
                          width: `${Math.max(4, (t.count / maxTag) * 100)}%`,
                        }}
                      />
                    </span>
                    <span className="cl-mono text-right text-[10px] tabular-nums text-ink-mute">
                      {t.count}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-5">
          <Panel label="Sky">
            <div className="cl-mono flex flex-col gap-1.5 text-[11px]">
              <KVLine k="Phase" v={`${sky.moonGlyph} ${sky.moonName}`} />
              <KVLine k="Sunrise" v={sky.sunrise} />
              <KVLine k="Sunset" v={sky.sunset} />
              <KVLine k="Light left" v={sky.lightLeft} />
              {sky.place && <KVLine k="At" v={sky.place} />}
            </div>
          </Panel>
          <Panel label="Aphorism">
            <blockquote className="m-0 font-sans text-[15px] italic leading-[1.5] text-ink-2">
              “{aphorism.text}”
            </blockquote>
            <div className="cl-mono mt-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute">
              — {aphorism.who}
            </div>
          </Panel>
          {bcl?.birth_date &&
            bcl.bcl_date &&
            bcl.remaining_seconds !== null && (
              <Panel label="Brimley-Cocoon Line">
                <div className="cl-mono text-[22px] leading-none text-accent">
                  {fmtBclDuration(bcl.remaining_seconds)}
                </div>
                <div className="cl-mono mt-1.5 text-[10px] text-ink-mute">
                  {bcl.remaining_seconds >= 0 ? "crosses" : "crossed"}{" "}
                  {fmtBclDate(bcl.bcl_date)} · natal {bcl.birth_date}
                </div>
              </Panel>
            )}
        </div>
      </section>

      {/* ── RECENTLY INSCRIBED ───────────────────────────────────────── */}
      <Panel label={`Recently inscribed · ${recent.length}`}>
        {recent.length === 0 ? (
          <p className="cl-marg m-0">∅ No folios yet inscribed.</p>
        ) : (
          <div className="flex flex-col">
            {recent.map((n) => {
              const kind = resolveKindFromPath(n.path);
              return (
                <button
                  type="button"
                  key={n.path}
                  onClick={() => openTab("page", n.path, n.title || n.path)}
                  className="grid cursor-pointer grid-cols-[90px_1fr_160px_64px] items-baseline gap-2 border-b border-dotted border-rule-soft py-1.5 text-left hover:bg-paper-2"
                >
                  <span className="cl-mono flex items-center gap-1.5 text-[10px] text-ink-mute">
                    <span
                      className="inline-block h-[6px] w-[6px] flex-shrink-0"
                      style={{ background: kindColorVar(kind) }}
                    />
                    {shortFolio(n.path)}
                  </span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[14px] text-ink">
                    {n.title || n.path}
                  </span>
                  <span className="cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[10px] text-accent">
                    {(n.tags || [])
                      .slice(0, 3)
                      .map((t) => `#${t}`)
                      .join(" ") || "—"}
                  </span>
                  <span className="cl-mono text-right text-[10px] text-ink-mute">
                    {formatRelativeTime(n.updated_at)}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Panel>

      {inscribeOpen && <InscribeModal onClose={() => setInscribeOpen(false)} />}
    </div>
  );
}

/* ── presentational ───────────────────────────────────────────────────── */

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value?: number | null;
  tone?: "warn";
}) {
  return (
    <div className="bg-paper px-4 py-3">
      <div
        className={`font-sans text-[28px] font-bold leading-none tabular-nums ${
          tone === "warn" ? "text-warn" : "text-ink"
        }`}
      >
        {value ?? "—"}
      </div>
      <div className="cl-mono mt-1 text-[9px] uppercase tracking-[0.16em] text-ink-mute">
        {label}
      </div>
    </div>
  );
}

function Panel({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="cl-frame px-4 py-3">
      <div className="cl-mono mb-2 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        § {label}
      </div>
      {children}
    </div>
  );
}

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

type HeatItem = { updated_at?: string | null; created_at?: string | null };

function buildHeatmap(items: HeatItem[]): {
  weeks: number[][];
  total: number;
} {
  const DAYS = 26 * 7;
  const counts = new Map<string, number>();
  let total = 0;
  for (const it of items) {
    const ts = it.updated_at ?? it.created_at;
    if (!ts) continue;
    const key = ts.slice(0, 10); // YYYY-MM-DD
    counts.set(key, (counts.get(key) ?? 0) + 1);
    total += 1;
  }
  // End on today; align grid start to the Sunday on/before (today - 181d).
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - (DAYS - 1));
  start.setDate(start.getDate() - start.getDay()); // back to Sunday

  const weeks: number[][] = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const week: number[] = [];
    for (let d = 0; d < 7; d++) {
      const key = cursor.toISOString().slice(0, 10);
      week.push(cursor <= today ? level(counts.get(key) ?? 0) : 0);
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return { weeks, total };
}

function level(n: number): number {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  if (n <= 3) return 2;
  if (n <= 6) return 3;
  return 4;
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

function julianDay(d: Date): number {
  // Julian Day Number at 00:00 UTC for the given date.
  const a = Math.floor((14 - (d.getMonth() + 1)) / 12);
  const y = d.getFullYear() + 4800 - a;
  const m = d.getMonth() + 1 + 12 * a - 3;
  return (
    d.getDate() +
    Math.floor((153 * m + 2) / 5) +
    365 * y +
    Math.floor(y / 4) -
    Math.floor(y / 100) +
    Math.floor(y / 400) -
    32045
  );
}

function dayOfYear(d: Date): number {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d.getTime() - start.getTime()) / 86_400_000);
}

const MOON_PHASES: [string, string][] = [
  ["🌑", "New"],
  ["🌒", "Waxing crescent"],
  ["🌓", "First quarter"],
  ["🌔", "Waxing gibbous"],
  ["🌕", "Full"],
  ["🌖", "Waning gibbous"],
  ["🌗", "Last quarter"],
  ["🌘", "Waning crescent"],
];

function buildSky(
  now: Date,
  lat: number | null,
  lon: number | null,
  label: string | null,
) {
  const hasLoc = lat !== null && lon !== null;
  const times = hasLoc
    ? SunCalc.getTimes(now, lat, lon)
    : { sunrise: dflt(now, 6), sunset: dflt(now, 20) };
  const sunsetMs = times.sunset.getTime();
  const remMin = Math.max(0, Math.floor((sunsetMs - now.getTime()) / 60_000));
  const illum = SunCalc.getMoonIllumination(now);
  const idx = Math.round(illum.phase * 8) % 8;
  const [glyph, name] = MOON_PHASES[idx];
  return {
    moonGlyph: glyph,
    moonName: name,
    sunrise: fmtTime(times.sunrise),
    sunset: fmtTime(times.sunset),
    lightLeft: `${Math.floor(remMin / 60)}h ${pad(remMin % 60)}m`,
    place: label,
  };
}

function dflt(now: Date, h: number): Date {
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

import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useBcl } from "#/api/bcl";
import { useContentIndex, useStats, useTags } from "#/api/index";
import { useJournalToday } from "#/api/journal";
import { useLocation } from "#/api/location";
import { useClock } from "#/hooks/useClock";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { kindColorVar, resolveKind } from "#/lib/kind";
import {
  dayOfYear,
  formatClock,
  formatRelativeTime,
  isLeapYear,
  julianDay,
  pad2,
} from "#/lib/time";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";
import {
  aphorismForDay,
  buildHeatmap,
  daystampLabel,
  deriveInventory,
  formatBclDate,
  formatBclDuration,
  formatDotDate,
  greeting,
  sortRecents,
} from "./atrium-data";
import { Card } from "./Card";
import { shortFolio } from "./folio-utils";
import { ReadingContinuesPanel } from "./ReadingContinues";
import { SkyCard } from "./SkyCard";
import { deriveSky, hasCoords } from "./sky";

export function Atrium() {
  const navigate = useNavigate();
  const { data: tags } = useTags();
  const { data: stats } = useStats();
  const { data: content } = useContentIndex(500);
  const { data: bcl } = useBcl();

  const { data: journalToday } = useJournalToday();
  const { data: location } = useLocation();
  const openSearch = useUiStore((s) => s.openSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openLocation = useUiStore((s) => s.openLocation);

  const items = content?.items ?? [];
  const now = useClock();

  const openTab = useOpenTab();
  const openHistory = useWorkspaceStore((s) => s.openHistory);
  const [recentTab, setRecentTab] = useState<"edited" | "created" | "opened">(
    "edited",
  );

  const byPath = useMemo(() => {
    const m = new Map<string, (typeof items)[number]>();
    for (const it of items) m.set(it.path, it);
    return m;
  }, [items]);

  const openHistoryMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of openHistory) m.set(h.path, h.openedAt);
    return m;
  }, [openHistory]);

  const recentRows = useMemo(() => {
    if (recentTab === "opened") {
      return openHistory
        .map((h) => byPath.get(h.path))
        .filter((x): x is (typeof items)[number] => Boolean(x))
        .slice(0, 8);
    }
    return sortRecents(items, recentTab);
  }, [recentTab, openHistory, byPath, items]);

  const todayLabel = daystampLabel(now);
  const doy = dayOfYear(now);
  const yearDays = isLeapYear(now.getFullYear()) ? 366 : 365;
  const week = Math.ceil(doy / 7);
  const clock = formatClock(now);
  const journalSub = journalToday?.meta.id
    ? `${journalToday.meta.id} · JOURNAL / ${formatDotDate(now)}`
    : `JOURNAL / ${formatDotDate(now)}`;

  const dayKeyDep = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;

  const heat = useMemo(() => buildHeatmap(items, now), [items, dayKeyDep]);
  const topTags = useMemo(
    () => [...(tags ?? [])].sort((a, b) => b.count - a.count).slice(0, 8),
    [tags],
  );
  const maxTag = topTags[0]?.count ?? 1;

  const inventory = useMemo(
    () => deriveInventory(stats, tags, items, now),
    [stats, tags, items, dayKeyDep],
  );

  const sky = useMemo(() => deriveSky(now, location), [location, now]);
  const located = hasCoords(location);

  const aphorism = aphorismForDay(now);

  return (
    <div className="mx-auto grid max-w-[1600px] auto-rows-min grid-cols-12 gap-3.5 px-4 py-4">
      {/* HERO — col-12 */}
      <section className="cl-grid-texture col-span-12 grid items-end gap-6 border border-rule bg-paper-2 px-6 py-5 md:grid-cols-[1fr_auto]">
        <div>
          <div className="cl-mono mb-3 flex flex-wrap items-center gap-4 text-[9px] uppercase tracking-[0.28em] text-ink-mute">
            <span className="text-accent">●</span>
            <span>
              DAYSTART / <b className="font-medium text-ink">{todayLabel}</b>
            </span>
            <span>WEEK {week}</span>
            <span>
              DAY {doy} / {yearDays}
            </span>
            <span>JD {julianDay(now)}</span>
            <span className="tabular-nums">{clock} LOCAL</span>
          </div>
          <h1 className="font-sans text-[clamp(40px,6vw,72px)] font-black leading-[0.95] tracking-[-0.02em] text-ink">
            {greeting(now)}
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
              <div className="mt-1 text-[9px] tracking-[0.18em] text-ink-mute">
                ⌘ N
              </div>
            </button>
            <button
              type="button"
              onClick={openSearch}
              className="cl-mono border border-rule bg-paper px-2.5 py-2 text-left text-[9px] uppercase tracking-[0.22em] text-ink-2 hover:border-ink-mute hover:text-ink"
            >
              Search
              <div className="mt-1 text-[9px] tracking-[0.18em] text-ink-mute">
                ⌘ K
              </div>
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
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 [&>div:last-child]:border-r-0">
          {inventory.map((cell, i) => (
            <div
              key={cell.label}
              className={cn(
                "flex flex-col gap-1 border-rule px-3.5 py-3",
                i % 8 !== 7 && "border-r",
                i >= 4 && "border-t lg:border-t-0",
              )}
            >
              <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
                {cell.label}
              </span>
              <span
                className={cn(
                  "font-sans text-[28px] font-bold leading-none tabular-nums",
                  cell.tone === "warn" ? "text-warn" : "text-ink",
                )}
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

      {/* APHORISM + BCL (stacked, col-7) + SKY (col-5) */}
      <div className="col-span-12 flex flex-col gap-3.5 lg:col-span-7">
        <Card className="flex-1" label="Aphorism" pip="dim" caption="FIG. II">
          <blockquote className="m-0 font-sans text-[18px] italic leading-[1.4] text-ink-2">
            “{aphorism.text}”
          </blockquote>
          <div className="cl-mono mt-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute">
            — {aphorism.who}
          </div>
        </Card>
        {bcl?.birth_date && bcl.bcl_date && bcl.remaining_seconds !== null && (
          <Card
            className="flex-1"
            label="Brimley-Cocoon Line"
            pip="dim"
            caption="FIG. VII"
          >
            <div className="cl-mono text-[22px] leading-none text-accent">
              {formatBclDuration(bcl.remaining_seconds)}
            </div>
            <div className="cl-mono mt-1.5 text-[10px] text-ink-mute">
              {bcl.remaining_seconds >= 0 ? "crosses" : "crossed"}{" "}
              {formatBclDate(bcl.bcl_date)} · natal {bcl.birth_date}
            </div>
          </Card>
        )}
      </div>
      <SkyCard
        className="col-span-12 lg:col-span-5"
        sky={sky}
        hasLocation={located}
        onEdit={openLocation}
      />

      {/* HEATMAP (col-8) + TAGS (col-4) */}
      <Card
        className="col-span-12 lg:col-span-8"
        label="Activity · Rolling 26 weeks"
        pip="cool"
        caption="FIG. IV — CAPTURES PER DAY · UTC"
      >
        <Heatmap weeks={heat.weeks} monthLabels={heat.monthLabels} />
        <HeatmapFooter
          total={heat.total}
          longest={heat.longestStreak}
          current={heat.currentStreak}
        />
      </Card>
      <Card
        className="col-span-12 lg:col-span-4"
        label="Subjects, by frequency"
        caption="FIG. V"
      >
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
      </Card>

      {/* RECENTS (col-7) */}
      <section className="col-span-12 flex h-[340px] flex-col border border-rule bg-paper-2 lg:col-span-7">
        <div className="flex items-center justify-between border-b border-rule bg-paper">
          <div className="flex">
            {(["edited", "created", "opened"] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setRecentTab(t)}
                className={cn(
                  "cl-mono border-r border-rule px-3.5 py-2 text-[9px] uppercase tracking-[0.22em]",
                  recentTab === t
                    ? "text-ink shadow-[inset_0_2px_0_var(--accent)]"
                    : "text-ink-mute hover:text-ink",
                )}
              >
                {t === "edited"
                  ? "Recently edited"
                  : t === "created"
                    ? "Recently created"
                    : "Opened"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-3 px-3 py-2">
            <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
              {recentRows.length} OF {items.length}
            </span>
            <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
              FIG. VI
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {recentRows.length === 0 ? (
            <p className="cl-marg m-0 p-3.5">
              {recentTab === "opened"
                ? "∅ Nothing opened yet this session."
                : "∅ No folios yet inscribed."}
            </p>
          ) : (
            <div className="flex flex-col">
              {recentRows.map((n, i) => {
                const kind = resolveKind({ path: n.path, kind: n.kind });
                const ts =
                  recentTab === "created"
                    ? n.created_at
                    : recentTab === "opened"
                      ? new Date(
                          openHistoryMap.get(n.path) ?? Date.now(),
                        ).toISOString()
                      : n.updated_at;
                return (
                  <button
                    type="button"
                    key={n.path}
                    onClick={() => openTab("page", n.path, n.title || n.path)}
                    className="grid cursor-pointer grid-cols-[18px_90px_1fr_72px] items-baseline gap-3 border-b border-dotted border-rule-soft px-3.5 py-2 text-left hover:bg-paper-edge"
                  >
                    <span className="cl-mono text-[9px] tabular-nums text-ink-mute">
                      {pad2(i + 1)}
                    </span>
                    <span className="cl-mono flex items-center gap-1.5 text-[9px] text-ink-mute">
                      <span
                        className="inline-block h-[6px] w-[6px] flex-shrink-0"
                        style={{ background: kindColorVar(kind) }}
                      />
                      {shortFolio(n.path)}
                    </span>
                    <span className="overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[14px] text-ink">
                      {n.title || n.path}
                    </span>
                    <span className="cl-mono text-right text-[9px] uppercase text-ink-mute">
                      {formatRelativeTime(ts)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </section>

      {/* READING CONTINUES — the bases pilot; hidden without a reading base */}
      <ReadingContinuesPanel />
    </div>
  );
}

/* ── presentational ───────────────────────────────────────────────────── */

const HEAT_LEVEL = [
  "bg-rule-soft",
  "bg-accent/30",
  "bg-accent/55",
  "bg-accent/80",
  "bg-warn",
  "bg-accent",
];
const DOW_LABELS = ["M", "", "W", "", "F", "", "S"]; // Monday-first rows

function Heatmap({
  weeks,
  monthLabels,
}: {
  weeks: number[][];
  monthLabels: string[];
}) {
  return (
    <div>
      <div className="mb-1.5 grid grid-cols-[22px_1fr] gap-2">
        <span />
        <div className="flex gap-[3px]">
          {monthLabels.map((m, i) => (
            <span
              key={`m${i}`}
              className="cl-mono min-w-0 flex-1 whitespace-nowrap text-[9px] uppercase tracking-[0.16em] text-ink-mute"
            >
              {m}
            </span>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-[22px_1fr] gap-2">
        <div className="grid grid-rows-7 gap-[3px] pr-1 text-right text-[9px] text-ink-mute">
          {DOW_LABELS.map((d, i) => (
            <span
              key={`dow${i}`}
              className="flex items-center justify-end leading-none"
            >
              {d}
            </span>
          ))}
        </div>
        <div className="flex gap-[3px]">
          {weeks.map((week, wi) => (
            <div
              key={`w${wi}`}
              className="flex min-w-0 flex-1 flex-col gap-[3px]"
            >
              {week.map((lvl, di) => (
                <span
                  key={`d${di}`}
                  className={cn("aspect-square w-full", HEAT_LEVEL[lvl])}
                />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function HeatmapFooter({
  total,
  longest,
  current,
}: {
  total: number;
  longest: number;
  current: number;
}) {
  return (
    <div className="cl-mono mt-3 flex flex-wrap items-center justify-between gap-2 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
      <span>
        TOTAL{" "}
        <b className="font-medium text-ink">{total.toLocaleString("en-US")}</b>{" "}
        · LONGEST <b className="font-medium text-ink">{longest}d</b> · CURRENT{" "}
        <b className="text-accent">{current}d</b>
      </span>
      <span className="flex items-center gap-1.5">
        LESS
        {HEAT_LEVEL.map((c, i) => (
          <i
            key={`leg${i}`}
            className={cn("inline-block h-3 w-3 border border-rule", c)}
          />
        ))}
        MORE
      </span>
    </div>
  );
}

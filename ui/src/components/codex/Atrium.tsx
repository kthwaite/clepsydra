import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useBcl } from "#/api/bcl";
import {
  useContentIndex,
  useReferenceIssues,
  useStats,
  useTags,
} from "#/api/index";
import { useJournalToday } from "#/api/journal";
import { useLocation } from "#/api/location";
import { useClock } from "#/hooks/useClock";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { cn } from "#/lib/cn";
import { kindColorVar, resolveKind } from "#/lib/kind";
import { formatClock, formatRelativeTime, pad2 } from "#/lib/time";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";
import { ActivityHeatmap } from "./ActivityHeatmap";
import {
  buildHeatmap,
  deriveInventory,
  formatBclDate,
  formatBclDuration,
  greeting,
  sortRecents,
} from "./atrium-data";
import { useAtriumCalendar } from "./atrium-time";
import { Card } from "./Card";
import { FeedRiverPanel } from "./FeedRiverPanel";
import { shortFolio } from "./folio-utils";
import { ReadingContinuesPanel } from "./ReadingContinues";
import { SkyCard } from "./SkyCard";
import { deriveSky, hasCoords } from "./sky";

const REFERENCE_ISSUE_COUNT_FILTERS = { limit: 1, offset: 0 };

export function Atrium() {
  const navigate = useNavigate();
  const { data: tags } = useTags();
  const { data: stats } = useStats();
  const { data: content } = useContentIndex({ limit: 500 });
  const { data: referenceIssues } = useReferenceIssues(
    REFERENCE_ISSUE_COUNT_FILTERS,
  );
  const { data: bcl } = useBcl();

  const { data: journalToday } = useJournalToday();
  const { data: location } = useLocation();
  const openSearch = useUiStore((s) => s.openSearch);
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openLocation = useUiStore((s) => s.openLocation);

  const items = content?.items ?? [];
  const now = useClock();

  const openTab = useOpenTab();
  const openTodayJournal = useOpenTodayJournal();
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

  const calendar = useAtriumCalendar(now);
  const clock = formatClock(now);
  const journalSub = journalToday?.meta.id
    ? `${journalToday.meta.id} · JOURNAL / ${calendar.dotDate}`
    : `JOURNAL / ${calendar.dotDate}`;

  const heat = useMemo(
    () => buildHeatmap(items, calendar.utcDate),
    [items, calendar],
  );
  const topTags = useMemo(
    () => [...(tags ?? [])].sort((a, b) => b.count - a.count).slice(0, 8),
    [tags],
  );
  const maxTag = topTags[0]?.count ?? 1;

  const inventory = useMemo(
    () => deriveInventory(stats, tags, items, calendar.utcDate),
    [stats, tags, items, calendar],
  );

  const skyMinute = Math.floor(now.getTime() / 60_000);
  const skyNow = useMemo(() => new Date(skyMinute * 60_000), [skyMinute]);
  const sky = useMemo(() => deriveSky(skyNow, location), [location, skyNow]);
  const located = hasCoords(location);

  const aphorism = calendar.aphorism;

  return (
    <div className="mx-auto grid max-w-[1600px] auto-rows-min grid-cols-12 gap-3.5 px-2 py-2 md:px-4 md:py-4">
      {/* HERO — col-12 */}
      <section className="cl-grid-texture col-span-12 grid items-end gap-6 border border-rule bg-paper-2 px-4 py-4 md:grid-cols-[1fr_auto] md:px-6 md:py-5">
        <div>
          <div className="cl-mono mb-3 flex flex-wrap items-center gap-4 text-[9px] uppercase tracking-[0.28em] text-ink-mute">
            <span className="text-accent">●</span>
            <span>
              DAYSTART /{" "}
              <b className="font-medium text-ink">{calendar.todayLabel}</b>
            </span>
            <span>WEEK {calendar.week}</span>
            <span>
              DAY {calendar.doy} / {calendar.yearDays}
            </span>
            <span>JD {calendar.julian}</span>
            <span className="tabular-nums">{clock} LOCAL</span>
          </div>
          <h1 className="font-sans text-[clamp(40px,6vw,72px)] font-black leading-[0.95] tracking-[-0.02em] text-ink">
            {greeting(now)}
          </h1>
        </div>

        <div className="flex flex-col gap-2 md:min-w-[280px]">
          <button
            type="button"
            onClick={openTodayJournal}
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
              <div className="mt-1 hidden text-[9px] tracking-[0.18em] text-ink-mute md:block">
                ⌘ N
              </div>
            </button>
            <button
              type="button"
              onClick={openSearch}
              className="cl-mono border border-rule bg-paper px-2.5 py-2 text-left text-[9px] uppercase tracking-[0.22em] text-ink-2 hover:border-ink-mute hover:text-ink"
            >
              Search
              <div className="mt-1 hidden text-[9px] tracking-[0.18em] text-ink-mute md:block">
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
        action={
          <button
            type="button"
            onClick={() => navigate({ to: "/repairs" })}
            aria-label={
              referenceIssues
                ? `Open Reference Repairs, ${referenceIssues.total.toLocaleString("en-US")} issues`
                : "Open Reference Repairs"
            }
            className="cl-mono border-l border-rule pl-2.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute hover:text-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          >
            {referenceIssues
              ? `${referenceIssues.total.toLocaleString("en-US")} issues`
              : "Repairs"}{" "}
            →
          </button>
        }
        tight
      >
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
          {inventory.map((cell, i) => (
            <div
              key={cell.label}
              className={cn(
                "flex flex-col gap-1 border-rule px-2.5 py-3 md:px-3.5",
                i % 2 === 0 ? "border-r" : "border-r-0",
                i >= 2 ? "border-t" : "border-t-0",
                i % 4 !== 3 ? "md:border-r" : "md:border-r-0",
                i >= 4 ? "md:border-t" : "md:border-t-0",
                i !== 7 ? "lg:border-r" : "lg:border-r-0",
                "lg:border-t-0",
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
        <Card
          className="flex-1 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5"
          label="Aphorism"
          pip="dim"
          caption="FIG. II"
        >
          <blockquote className="m-0 font-sans text-[18px] italic leading-[1.4] text-ink-2">
            “{aphorism.text}”
          </blockquote>
          <div className="cl-mono mt-2 text-[10px] uppercase tracking-[0.16em] text-ink-mute">
            — {aphorism.who}
          </div>
        </Card>
        {bcl?.birth_date && bcl.bcl_date && bcl.remaining_seconds !== null && (
          <Card
            className="flex-1 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5"
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
        className="col-span-12 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5 lg:col-span-5"
        sky={sky}
        hasLocation={located}
        onEdit={openLocation}
      />

      {/* HEATMAP (col-8) + TAGS (col-4) */}
      <Card
        className="col-span-12 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5 lg:col-span-8"
        label="Activity · Rolling 26 weeks"
        pip="cool"
        caption="FIG. IV — CAPTURES PER DAY · UTC"
      >
        <ActivityHeatmap
          weeks={heat.weeks}
          monthLabels={heat.monthLabels}
          total={heat.total}
          longest={heat.longestStreak}
          current={heat.currentStreak}
          onOpenPage={(path, title) => openTab("page", path, title)}
        />
      </Card>
      <Card
        className="col-span-12 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5 lg:col-span-4"
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
                    search: { tags: [t.tag] } as never,
                  })
                }
                className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_minmax(60px,1fr)_32px] items-center gap-2 text-left md:grid-cols-[120px_1fr_36px]"
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

      <FeedRiverPanel />

      {/* RECENTS (col-7) */}
      <section className="col-span-12 flex h-[340px] flex-col border border-rule bg-paper-2 lg:col-span-7">
        <div className="flex flex-col border-b border-rule bg-paper md:flex-row md:items-center md:justify-between">
          <div className="flex">
            {(["edited", "created", "opened"] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setRecentTab(t)}
                className={cn(
                  "cl-mono flex-1 border-r border-rule px-2 py-2 text-[9px] uppercase tracking-[0.22em] md:flex-none md:px-3.5",
                  recentTab === t
                    ? "text-ink shadow-[inset_0_2px_0_var(--accent)]"
                    : "text-ink-mute hover:text-ink",
                )}
              >
                <span className="md:hidden">
                  {t === "edited"
                    ? "Edited"
                    : t === "created"
                      ? "Created"
                      : "Opened"}
                </span>
                <span className="hidden md:inline">
                  {t === "edited"
                    ? "Recently edited"
                    : t === "created"
                      ? "Recently created"
                      : "Opened"}
                </span>
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
                    className="grid cursor-pointer grid-cols-[18px_minmax(0,1fr)_auto] items-baseline gap-x-2 gap-y-1 border-b border-dotted border-rule-soft px-2.5 py-2 text-left hover:bg-paper-edge md:grid-cols-[18px_90px_1fr_72px] md:gap-3 md:px-3.5"
                  >
                    <span className="cl-mono row-span-2 text-[9px] tabular-nums text-ink-mute md:row-span-1">
                      {pad2(i + 1)}
                    </span>
                    <span className="cl-mono col-start-2 row-start-1 flex min-w-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap text-[9px] text-ink-mute md:col-start-auto md:row-start-auto">
                      <span
                        className="inline-block h-[6px] w-[6px] flex-shrink-0"
                        style={{ background: kindColorVar(kind) }}
                      />
                      {shortFolio(n.path)}
                    </span>
                    <span className="col-span-2 col-start-2 row-start-2 overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[14px] text-ink md:col-span-1 md:col-start-auto md:row-start-auto">
                      {n.title || n.path}
                    </span>
                    <span className="cl-mono col-start-3 row-start-1 text-right text-[9px] uppercase text-ink-mute md:col-start-auto md:row-start-auto">
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

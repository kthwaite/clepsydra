import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useBcl } from "#/api/bcl";
import { useContentIndex } from "#/api/index";
import { useJournalToday } from "#/api/journal";
import { useLocation } from "#/api/location";
import { useFeatureFlags } from "#/components/FeatureFlagsProvider";
import { KindIcon } from "#/components/KindIcon";
import { useClock } from "#/hooks/useClock";
import { useOpenTab } from "#/hooks/useOpenTab";
import { useOpenTodayAiJournal } from "#/hooks/useOpenTodayAiJournal";
import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { resolveKind } from "#/lib/kind";
import { formatRelativeTime, pad2 } from "#/lib/time";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";
import { ActivityHeatmap } from "./ActivityHeatmap";
import { AgendaTile } from "./AgendaTile";
import {
  buildHeatmap,
  formatBclDate,
  formatBclDuration,
  greeting,
  sortRecents,
} from "./atrium-data";
import { useAtriumCalendar } from "./atrium-time";
import { FeedRiverPanel } from "./FeedRiverPanel";
import { shortFolio } from "./folio-utils";
import { ReadingContinuesPanel } from "./ReadingContinues";
import { Section } from "./Section";
import { SkyCard } from "./SkyCard";
import { deriveSky, hasCoords } from "./sky";
import { Tick } from "./Tick";

export function Atrium() {
  const features = useFeatureFlags();
  const { data: content } = useContentIndex({ limit: 500 });
  const { data: bcl } = useBcl();
  const configuredBcl =
    bcl?.birth_date && bcl.bcl_date && bcl.remaining_seconds !== null
      ? {
          birthDate: bcl.birth_date,
          date: bcl.bcl_date,
          remainingSeconds: bcl.remaining_seconds,
        }
      : null;

  const { data: journalToday } = useJournalToday();
  const { data: location } = useLocation();
  const openInscribe = useUiStore((s) => s.openInscribe);
  const openLocation = useUiStore((s) => s.openLocation);

  const items = content?.items ?? [];
  const now = useClock();

  const openTab = useOpenTab();
  const navigate = useNavigate();
  const openTodayJournal = useOpenTodayJournal();
  const openTodayAiJournal = useOpenTodayAiJournal();
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
  const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const journalSub = journalToday?.meta.id
    ? `${journalToday.meta.id} · Journal · ${calendar.dotDate}`
    : `Journal · ${calendar.dotDate}`;
  const longDate = `${now.toLocaleDateString("en-GB", { weekday: "long" })} ${now.getDate()} ${now.toLocaleDateString("en-GB", { month: "long" })} ${now.getFullYear()}`;

  const heat = useMemo(
    () => buildHeatmap(items, calendar.utcDate),
    [items, calendar],
  );

  const skyMinute = Math.floor(now.getTime() / 60_000);
  const skyNow = useMemo(() => new Date(skyMinute * 60_000), [skyMinute]);
  const sky = useMemo(() => deriveSky(skyNow, location), [location, skyNow]);
  const located = hasCoords(location);

  return (
    <div className="mx-auto grid max-w-[1600px] auto-rows-min grid-cols-12 gap-x-24 gap-y-[112px] px-6 pt-12 pb-24 md:px-10 xl:px-[120px] xl:pt-[88px] xl:pb-[120px]">
      {/* HERO — col-12 */}
      <section className="col-span-12 grid items-end gap-12 md:grid-cols-[minmax(0,1fr)_340px] xl:gap-24">
        <div>
          <div className="flex flex-wrap items-center gap-3 text-[14px] text-mute">
            <Tick variant="pulse" />
            <span className="text-ink">{longDate}</span>
            <span aria-hidden>·</span>
            <span>Week {calendar.week}</span>
            <span aria-hidden>·</span>
            <span>
              Day {calendar.doy} of {calendar.yearDays}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{clock} local</span>
          </div>
          <h1 className="mt-[22px] font-serif text-[clamp(56px,8vw,112px)] leading-[0.95] tracking-[-0.025em] text-ink">
            {greeting(now)}
          </h1>
        </div>

        <div className="flex flex-col gap-2.5 pb-2">
          <button
            type="button"
            onClick={openTodayJournal}
            className={cn(
              "grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-[18px] bg-accent px-[22px] py-[18px] text-left text-raise transition-[filter] hover:brightness-95",
              FOCUS_RING_NATIVE,
            )}
          >
            <span className="flex flex-col gap-1">
              <span className="text-[16px] font-medium">
                Open today’s journal
              </span>
              <span className="text-[12.5px] opacity-80">{journalSub}</span>
            </span>
            <span aria-hidden className="text-[18px]">
              →
            </span>
          </button>
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={openInscribe}
              className={cn(
                "flex cursor-pointer items-baseline justify-between rounded-[14px] bg-sink px-4 py-3 text-left text-[14.5px] text-ink hover:bg-sink/70",
                FOCUS_RING_NATIVE,
              )}
            >
              Capture
              <span className="text-[12px] text-mute">⌘N</span>
            </button>
            <button
              type="button"
              onClick={openTodayAiJournal}
              className={cn(
                "flex cursor-pointer items-baseline justify-between rounded-[14px] bg-sink px-4 py-3 text-left text-[14.5px] text-ink hover:bg-sink/70",
                FOCUS_RING_NATIVE,
              )}
            >
              AI journal
            </button>
          </div>
        </div>
      </section>
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
              {recentRows.length} of {items.length.toLocaleString()}
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
                      <KindIcon
                        kind={kind}
                        size={11}
                        className="flex-shrink-0"
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
      <AgendaTile className="col-span-12 lg:col-span-5" />

      {features.feeds ? <FeedRiverPanel /> : null}
      {/* BCL (col-7) + SKY (col-5) */}
      <div className="col-span-12 grid grid-cols-12 gap-3.5">
        {configuredBcl ? (
          <Section
            className="col-span-12 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5 lg:col-span-7"
            label="Brimley-Cocoon Line"
            pip="dim"
          >
            <div className="cl-mono text-[22px] leading-none text-accent">
              {formatBclDuration(configuredBcl.remainingSeconds)}
            </div>
            <div className="cl-mono mt-1.5 text-[10px] text-ink-mute">
              {configuredBcl.remainingSeconds >= 0 ? "crosses" : "crossed"}{" "}
              {formatBclDate(configuredBcl.date)} · natal{" "}
              {configuredBcl.birthDate}
            </div>
          </Section>
        ) : null}
        <SkyCard
          className={cn(
            "col-span-12 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5",
            configuredBcl ? "lg:col-span-5" : "lg:col-span-12",
          )}
          sky={sky}
          hasLocation={located}
          onEdit={openLocation}
        />
      </div>

      {/* HEATMAP */}
      <Section
        className="col-span-12 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5"
        label="Activity · Rolling 26 weeks"
        pip="cool"
        caption="Captures per day · UTC"
        wrapHeader
        action={
          <button
            type="button"
            onClick={() => navigate({ to: "/stats" })}
            className="cl-mono border-l border-rule pl-2.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute hover:text-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          >
            Stats →
          </button>
        }
      >
        <ActivityHeatmap
          weeks={heat.weeks}
          monthLabels={heat.monthLabels}
          total={heat.total}
          longest={heat.longestStreak}
          current={heat.currentStreak}
          onOpenPage={(path, title) => openTab("page", path, title)}
        />
      </Section>

      {/* READING CONTINUES — the bases pilot; hidden without a reading base */}
      <ReadingContinuesPanel />
    </div>
  );
}

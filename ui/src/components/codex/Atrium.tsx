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
      <section className="col-span-12 flex min-w-0 flex-col gap-[22px] lg:col-span-7">
        <div className="flex flex-wrap items-center gap-3">
          <Tick />
          <h2 className="font-serif text-[22px] italic leading-none text-ink">
            Recent
          </h2>
          <div className="ml-4 flex gap-5 text-[14px]">
            {(["edited", "created", "opened"] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setRecentTab(t)}
                aria-pressed={recentTab === t}
                className={cn(
                  "cursor-pointer rounded-sm",
                  FOCUS_RING_NATIVE,
                  recentTab === t
                    ? "font-medium text-ink underline decoration-accent decoration-[1.5px] underline-offset-[7px]"
                    : "text-mute hover:text-ink",
                )}
              >
                {t === "edited"
                  ? "Edited"
                  : t === "created"
                    ? "Created"
                    : "Opened"}
              </button>
            ))}
          </div>
          <span className="flex-1" />
          <span className="text-[13px] tabular-nums text-mute">
            {recentRows.length} of {items.length.toLocaleString()}
          </span>
        </div>

        <div className="flex flex-col pl-[19px]">
          {recentRows.length === 0 ? (
            <p className="m-0 py-3 text-[14px] text-mute">
              {recentTab === "opened"
                ? "Nothing opened yet this session."
                : "No pages yet."}
            </p>
          ) : (
            recentRows.map((n, i) => {
              const kind = resolveKind({ path: n.path, kind: n.kind });
              const ts =
                recentTab === "created"
                  ? n.created_at
                  : recentTab === "opened"
                    ? new Date(
                        openHistoryMap.get(n.path) ?? Date.now(),
                      ).toISOString()
                    : n.updated_at;
              const folder = n.path.includes("/")
                ? n.path.slice(0, n.path.lastIndexOf("/"))
                : "";
              return (
                <button
                  type="button"
                  key={n.path}
                  onClick={() => openTab("page", n.path, n.title || n.path)}
                  className={cn(
                    "grid cursor-pointer grid-cols-[34px_22px_minmax(0,1fr)_72px] items-baseline gap-3 rounded-md py-[11px] text-left text-ink hover:text-accent md:grid-cols-[34px_22px_minmax(0,1fr)_170px_72px]",
                    FOCUS_RING_NATIVE,
                  )}
                >
                  <span className="font-serif text-[16px] tabular-nums text-faint">
                    {pad2(i + 1)}
                  </span>
                  <span className="text-mute">
                    <KindIcon kind={kind} tone="mono" size={13} />
                  </span>
                  <span className="truncate text-[16px]">
                    {n.title || n.path}
                  </span>
                  <span className="hidden truncate text-[13px] text-mute md:block">
                    {folder}
                  </span>
                  <span className="text-right text-[13px] text-mute">
                    {formatRelativeTime(ts)}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </section>
      <AgendaTile className="col-span-12 lg:col-span-5" />

      {features.feeds ? <FeedRiverPanel /> : null}
      {/* BCL (col-7) + SKY (col-5) */}
      <div className="col-span-12 grid grid-cols-12 gap-3.5">
        {configuredBcl ? (
          <Section
            className="col-span-12 lg:col-span-7"
            label="Brimley-Cocoon Line"
            pip="dim"
          >
            <div
              data-testid="bcl-figure"
              className="font-serif text-[clamp(48px,6vw,96px)] leading-none tracking-[-0.02em] tabular-nums text-accent"
            >
              {formatBclDuration(configuredBcl.remainingSeconds)}
            </div>
            <div className="mt-3.5 text-[15px] text-ink-2">
              {configuredBcl.remainingSeconds >= 0 ? "crosses" : "crossed"}{" "}
              {formatBclDate(configuredBcl.date)} · natal{" "}
              {configuredBcl.birthDate}
            </div>
          </Section>
        ) : null}
        <SkyCard
          className={cn(
            "col-span-12",
            configuredBcl ? "lg:col-span-5" : "lg:col-span-12",
          )}
          sky={sky}
          hasLocation={located}
          onEdit={openLocation}
        />
      </div>

      {/* HEATMAP */}
      <Section
        className="col-span-12"
        label="Activity"
        pip="cool"
        caption="Rolling 26 weeks · captures per day"
        wrapHeader
        action={
          <button
            type="button"
            onClick={() => navigate({ to: "/stats" })}
            className={cn(
              "cursor-pointer rounded-sm text-[14px] text-accent hover:underline",
              FOCUS_RING_NATIVE,
            )}
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

import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  shift,
  useDismiss,
  useFloating,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import type React from "react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { HeatmapDay } from "./atrium-data";

export interface ActivityHeatmapProps {
  weeks: HeatmapDay[][];
  monthLabels: string[];
  total: number;
  longest: number;
  current: number;
  onOpenPage: (path: string, title: string) => void;
}

/** Empty days sit on `sink`; activity climbs in cobalt alpha steps
 *  (spec §5.6: 22 / 45 / 70 / 100%, with 85% for the fifth data level). */
const HEAT_LEVEL = [
  "bg-sink",
  "bg-accent/[0.22]",
  "bg-accent/[0.45]",
  "bg-accent/[0.7]",
  "bg-accent/[0.85]",
  "bg-accent",
];
const DOW_LABELS = [
  { key: "monday", label: "M" },
  { key: "tuesday", label: "" },
  { key: "wednesday", label: "W" },
  { key: "thursday", label: "" },
  { key: "friday", label: "F" },
  { key: "saturday", label: "" },
  { key: "sunday", label: "S" },
]; // Monday-first rows
const VISIBLE_PAGES = 5;
const DATE_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(date: string): string {
  return DATE_FORMATTER.format(new Date(`${date}T00:00:00Z`));
}

function captureCount(count: number): string {
  return `${count} ${count === 1 ? "capture" : "captures"}`;
}

export function ActivityHeatmap({
  weeks,
  monthLabels,
  total,
  longest,
  current,
  onOpenPage,
}: ActivityHeatmapProps): React.JSX.Element {
  const dialogId = useId();
  const headingId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const suppressedFocusTargetRef = useRef<HTMLButtonElement | null>(null);
  const openReasonRef = useRef<"focus" | "pointer" | "press">("pointer");
  const [activeDay, setActiveDay] = useState<HeatmapDay | null>(null);
  const focusManagerEnabled =
    activeDay !== null && openReasonRef.current === "focus";

  const { context, floatingStyles, placement, refs } = useFloating({
    open: activeDay !== null,
    onOpenChange(isOpen) {
      if (!isOpen) closeDay();
    },
    placement: "top",
    strategy: "fixed",
    middleware: [offset(8), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getFloatingProps } = useInteractions([dismiss, role]);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  function openDay(
    day: HeatmapDay,
    trigger: HTMLButtonElement,
    reason: "focus" | "pointer" | "press",
  ) {
    cancelClose();
    openReasonRef.current = reason;
    triggerRef.current = trigger;
    refs.setReference(trigger);
    setActiveDay(day);
  }

  function focusDay(day: HeatmapDay, trigger: HTMLButtonElement) {
    if (suppressedFocusTargetRef.current === trigger) {
      suppressedFocusTargetRef.current = null;
      return;
    }
    openDay(day, trigger, "focus");
  }

  function closeDay() {
    const shouldSuppressRestoredFocus =
      focusManagerEnabled &&
      refs.floating.current?.contains(document.activeElement);
    cancelClose();
    suppressedFocusTargetRef.current = shouldSuppressRestoredFocus
      ? triggerRef.current
      : null;
    setActiveDay(null);
  }

  function scheduleClose(trigger = triggerRef.current) {
    cancelClose();
    closeTimerRef.current = window.setTimeout(() => {
      if (triggerRef.current !== trigger) return;
      if (refs.floating.current?.contains(document.activeElement)) return;
      if (trigger?.contains(document.activeElement)) return;
      closeDay();
    }, 100);
  }

  useEffect(() => cancelClose, [cancelClose]);
  const activeDate = activeDay ? formatDate(activeDay.date) : "";
  const labeledMonths = monthLabels.map((month, monthIndex) => ({
    key: weeks[monthIndex]?.[0]?.date ?? `month:${month}`,
    month,
  }));

  return (
    <>
      <div className="flex flex-wrap items-end gap-x-24 gap-y-8">
        <div className="min-w-0 max-w-[560px] flex-1">
          <div className="mb-2.5 grid grid-cols-[22px_1fr] gap-2">
            <span />
            <div className="flex gap-[3px]">
              {labeledMonths.map(({ key, month }) => (
                <span
                  key={key}
                  className="min-w-0 flex-1 whitespace-nowrap text-[12px] text-mute"
                >
                  {month.charAt(0) + month.slice(1).toLowerCase()}
                </span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-[22px_1fr] gap-2">
            <div className="grid grid-rows-7 gap-1 pr-1 text-right text-[11.5px] text-faint">
              {DOW_LABELS.map(({ key, label }) => (
                <span
                  key={key}
                  className="flex items-center justify-end leading-none"
                >
                  {label}
                </span>
              ))}
            </div>
            <div className="flex gap-1">
              {weeks.map((week) => (
                <div
                  key={week[0]?.date ?? week.at(-1)?.date}
                  className="flex min-w-0 flex-1 flex-col gap-1"
                >
                  {week.map((day) => {
                    const cellClassName = cn(
                      "aspect-square w-full rounded-[3px]",
                      HEAT_LEVEL[day.level],
                    );
                    if (day.isFuture) {
                      return (
                        <span
                          key={day.date}
                          aria-hidden="true"
                          className={cellClassName}
                        />
                      );
                    }

                    const date = formatDate(day.date);
                    return (
                      <button
                        key={day.date}
                        type="button"
                        aria-label={`${date}, ${captureCount(day.count)}`}
                        aria-haspopup="dialog"
                        aria-expanded={activeDay?.date === day.date}
                        aria-controls={
                          activeDay?.date === day.date ? dialogId : undefined
                        }
                        className={cn(
                          cellClassName,
                          "cursor-pointer",
                          FOCUS_RING_NATIVE,
                        )}
                        onPointerEnter={(event) =>
                          openDay(day, event.currentTarget, "pointer")
                        }
                        onPointerLeave={(event) =>
                          scheduleClose(event.currentTarget)
                        }
                        onFocus={(event) => focusDay(day, event.currentTarget)}
                        onBlur={(event) => scheduleClose(event.currentTarget)}
                        onClick={(event) =>
                          openDay(day, event.currentTarget, "press")
                        }
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          <div className="mt-3 flex items-center gap-1.5 text-[12px] text-mute">
            Less
            {HEAT_LEVEL.map((className) => (
              <i
                key={className}
                className={cn("inline-block h-3 w-3 rounded-[3px]", className)}
              />
            ))}
            More
          </div>
        </div>

        <dl className="m-0 flex gap-16 pb-1">
          <SummaryFigure
            value={total.toLocaleString("en-US")}
            label="captures"
          />
          <SummaryFigure value={String(longest)} label="longest streak, days" />
          <SummaryFigure
            value={String(current)}
            label="current streak"
            accent
          />
        </dl>
      </div>

      {activeDay ? (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            disabled={!focusManagerEnabled}
            initialFocus={-1}
            modal={false}
            order={["reference", "content"]}
          >
            <div
              ref={refs.setFloating}
              data-placement={placement}
              style={floatingStyles}
              className="z-50 w-72 overflow-hidden rounded-xl bg-raise shadow-lg outline-none focus-visible:ring-2 focus-visible:ring-accent"
              {...getFloatingProps({
                id: dialogId,
                "aria-labelledby": headingId,
                tabIndex: -1,
                onPointerEnter: cancelClose,
                onPointerLeave: () => scheduleClose(),
                onFocusCapture: cancelClose,
                onBlurCapture: (event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) {
                    scheduleClose();
                  }
                },
              })}
            >
              <div className="px-4 pt-3.5 pb-2">
                <h2 id={headingId} className="font-serif text-[18px] text-ink">
                  {activeDate} activity
                </h2>
                <p className="mt-0.5 text-[12.5px] text-mute">
                  {captureCount(activeDay.count)}
                </p>
              </div>
              {activeDay.pages.length > 0 ? (
                <div className="flex flex-col px-1.5 pb-1.5">
                  {activeDay.pages.slice(0, VISIBLE_PAGES).map((page) => {
                    const title = page.title || page.path;
                    return (
                      <button
                        key={`${page.path}:${page.activityAt}`}
                        type="button"
                        aria-label={`Open ${title}`}
                        className={cn(
                          "cursor-pointer truncate rounded-lg px-2.5 py-1.5 text-left text-[13.5px] text-ink hover:bg-sink",
                          FOCUS_RING_NATIVE,
                        )}
                        onClick={() => {
                          closeDay();
                          onOpenPage(page.path, title);
                        }}
                      >
                        {title}
                      </button>
                    );
                  })}
                  {activeDay.pages.length > VISIBLE_PAGES ? (
                    <span className="px-2.5 py-1.5 text-[12.5px] text-mute">
                      +{activeDay.pages.length - VISIBLE_PAGES} more
                    </span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      ) : null}
    </>
  );
}

function SummaryFigure({
  value,
  label,
  accent = false,
}: {
  value: string;
  label: string;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col-reverse gap-1">
      <dt className="text-[13px] text-mute">{label}</dt>
      <dd
        className={cn(
          "m-0 font-serif text-[56px] leading-none tabular-nums",
          accent ? "text-accent" : "text-ink",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

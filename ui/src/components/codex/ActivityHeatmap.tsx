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
import { useEffect, useId, useRef, useState } from "react";
import { cn } from "#/lib/cn";
import type { HeatmapDay } from "./atrium-data";

export interface ActivityHeatmapProps {
  weeks: HeatmapDay[][];
  monthLabels: string[];
  total: number;
  longest: number;
  current: number;
  onOpenPage: (path: string, title: string) => void;
}

const HEAT_LEVEL = [
  "bg-rule-soft",
  "bg-accent/30",
  "bg-accent/55",
  "bg-accent/80",
  "bg-warn",
  "bg-accent",
];
const DOW_LABELS = ["M", "", "W", "", "F", "", "S"]; // Monday-first rows
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

  function cancelClose() {
    if (closeTimerRef.current === null) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }

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

  useEffect(() => cancelClose, []);
  const activeDate = activeDay ? formatDate(activeDay.date) : "";

  return (
    <>
      <div>
        <div className="mb-1.5 grid grid-cols-[22px_1fr] gap-2">
          <span />
          <div className="flex gap-[3px]">
            {monthLabels.map((month, index) => (
              <span
                key={`m${index}`}
                className="cl-mono min-w-0 flex-1 whitespace-nowrap text-[9px] uppercase tracking-[0.16em] text-ink-mute"
              >
                {month}
              </span>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-[22px_1fr] gap-2">
          <div className="grid grid-rows-7 gap-[3px] pr-1 text-right text-[9px] text-ink-mute">
            {DOW_LABELS.map((label, index) => (
              <span
                key={`dow${index}`}
                className="flex items-center justify-end leading-none"
              >
                {label}
              </span>
            ))}
          </div>
          <div className="flex gap-[3px]">
            {weeks.map((week, weekIndex) => (
              <div
                key={`w${weekIndex}`}
                className="flex min-w-0 flex-1 flex-col gap-[3px]"
              >
                {week.map((day) => {
                  const cellClassName = cn(
                    "aspect-square w-full",
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
                        "cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1",
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
      </div>

      <div className="cl-mono mt-3 flex flex-wrap items-center justify-between gap-2 text-[9px] uppercase tracking-[0.18em] text-ink-mute">
        <span>
          TOTAL{" "}
          <b className="font-medium text-ink">
            {total.toLocaleString("en-US")}
          </b>{" "}
          · LONGEST <b className="font-medium text-ink">{longest}d</b> · CURRENT{" "}
          <b className="text-accent">{current}d</b>
        </span>
        <span className="flex items-center gap-1.5">
          LESS
          {HEAT_LEVEL.map((className, index) => (
            <i
              key={`leg${index}`}
              className={cn(
                "inline-block h-3 w-3 border border-rule",
                className,
              )}
            />
          ))}
          MORE
        </span>
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
              className="z-50 w-72 border border-rule bg-paper outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-1"
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
              <div className="border-b border-rule bg-paper-2 px-3 py-2">
                <h2
                  id={headingId}
                  className="cl-mono text-[10px] font-medium uppercase tracking-[0.18em] text-ink"
                >
                  {activeDate} activity
                </h2>
                <p className="cl-mono mt-1 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                  {captureCount(activeDay.count)}
                </p>
              </div>
              {activeDay.pages.length > 0 ? (
                <div className="flex flex-col py-1">
                  {activeDay.pages
                    .slice(0, VISIBLE_PAGES)
                    .map((page, occurrenceIndex) => {
                      const title = page.title || page.path;
                      return (
                        <button
                          key={`${page.path}:${page.activityAt}:${occurrenceIndex}`}
                          type="button"
                          aria-label={`Open ${title}`}
                          className="cl-mono cursor-pointer px-3 py-2 text-left text-[10px] text-ink-2 hover:bg-paper-edge hover:text-ink focus-visible:bg-paper-edge focus-visible:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent focus-visible:outline-offset-[-1px]"
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
                    <span className="cl-mono px-3 py-2 text-[9px] uppercase tracking-[0.14em] text-ink-mute">
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

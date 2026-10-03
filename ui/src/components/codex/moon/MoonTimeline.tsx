import { useEffect, useRef } from "react";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  clampToBounds,
  dragTo,
  formatMoonInstant,
  HOUR_MS,
  keyStep,
  scrubBounds,
  snapToHour,
  timelineLabels,
  timelineTicks,
} from "./timeline";

export interface MoonTimelineProps {
  value: Date;
  now: Date;
  onChange: (date: Date) => void;
  /** Strip scale; the default fits about two days across a dialog. */
  pxPerHour?: number;
  className?: string;
}

/** A horizontal scrubber over ±3 days of hourly ticks. The cobalt marker
 *  stays at the centre and the strip slides under it. */
export function MoonTimeline({
  value,
  now,
  onChange,
  pxPerHour = 8,
  className,
}: MoonTimelineProps) {
  const sliderRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; start: Date; id: number } | null>(null);
  // The wheel listener is native (non-passive), so it reads the latest
  // props through a ref instead of re-subscribing per render.
  const latest = useRef({ value, now, onChange, pxPerHour });
  latest.current = { value, now, onChange, pxPerHour };

  useEffect(() => {
    const el = sliderRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const dx = e.deltaX !== 0 ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (dx === 0) return;
      e.preventDefault();
      const cur = latest.current;
      cur.onChange(
        clampToBounds(
          cur.value.getTime() + (dx / cur.pxPerHour) * HOUR_MS,
          cur.now,
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const ticks = timelineTicks(value, pxPerHour);
  const labels = timelineLabels(value, now, pxPerHour);
  const { min, max } = scrubBounds(now);
  const atNow = Math.abs(value.getTime() - now.getTime()) < 60_000;

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label="Moon time"
        aria-orientation="horizontal"
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value.getTime()}
        aria-valuetext={formatMoonInstant(value)}
        className={cn(
          "relative h-[72px] cursor-grab touch-none select-none overflow-hidden rounded-[12px] bg-sink active:cursor-grabbing",
          FOCUS_RING_NATIVE,
        )}
        onKeyDown={(e) => {
          const next = keyStep(e.key, e.shiftKey, value, now);
          if (!next) return;
          e.preventDefault();
          onChange(next);
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          drag.current = { x: e.clientX, start: value, id: e.pointerId };
          e.currentTarget.setPointerCapture?.(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          onChange(dragTo(d.start, e.clientX - d.x, pxPerHour, now));
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          drag.current = null;
          if (e.clientX !== d.x) {
            onChange(
              snapToHour(dragTo(d.start, e.clientX - d.x, pxPerHour, now)),
            );
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        <div aria-hidden className="absolute inset-0">
          {labels.map((l) => (
            <span
              key={l.time.getTime()}
              className={cn(
                "absolute top-2 -translate-x-1/2 whitespace-nowrap text-[12.5px]",
                l.today ? "font-medium text-ink" : "text-mute",
              )}
              style={{ left: `calc(50% + ${l.offsetPx}px)` }}
            >
              {l.text}
            </span>
          ))}
          {ticks.map((t) => (
            <span
              key={t.time.getTime()}
              className={cn(
                "absolute bottom-3 w-px -translate-x-1/2 rounded-full",
                t.kind === "day" ? "h-6 bg-mute" : "h-3 bg-faint",
              )}
              style={{ left: `calc(50% + ${t.offsetPx}px)` }}
            />
          ))}
          <span className="absolute top-7 bottom-2 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent" />
          <svg
            aria-hidden="true"
            className="absolute top-[22px] left-1/2 -translate-x-1/2 fill-accent"
            width="12"
            height="8"
            viewBox="0 0 12 8"
          >
            <path d="M0 0 H12 L6 8 Z" />
          </svg>
        </div>
      </div>
      <div className="flex justify-end">
        <Button
          variant="ghost"
          size="sm"
          isDisabled={atNow}
          onPress={() => onChange(new Date(now.getTime()))}
        >
          Now
        </Button>
      </div>
    </div>
  );
}

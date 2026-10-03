import { useId } from "react";
import { Button, Tooltip, TooltipTrigger } from "react-aria-components";
import { cn } from "#/lib/cn";
import { FOCUS_RING } from "#/lib/focusRing";
import { MoonFace } from "./moon/MoonFace";
import { MOON_GLYPHS, MOON_NAMES, type MoonInfo } from "./sky";

const FACE_PX = 64;

/**
 * The card's moon with an "engraved instrument" treatment: the real moon face
 * ({@link MoonFace}, lit and oriented as seen now) on a sink tile, and a phase
 * gauge of vertical ticks along the top and bottom edges (one per named phase,
 * current in accent) where each tick names its phase on hover/focus. With
 * `onOpen`, the disc itself is a button that opens the moon details.
 */
export function MoonDisc({
  info,
  date,
  onOpen,
}: {
  info: MoonInfo;
  date: Date;
  onOpen?: () => void;
}) {
  const currentIdx = MOON_NAMES.indexOf(info.phaseName);
  const labelId = useId();
  const face = <MoonFace date={date} size={FACE_PX} />;
  return (
    <figure
      aria-labelledby={labelId}
      className="relative m-0 flex h-24 w-24 items-center justify-center rounded-xl bg-sink"
    >
      <figcaption id={labelId} className="sr-only">
        {info.phaseName} · {info.illumPct}%
      </figcaption>
      <PhaseGauge edge="top" currentIdx={currentIdx} />
      <PhaseGauge edge="bottom" currentIdx={currentIdx} />
      {onOpen ? (
        <Button
          aria-label="Moon details"
          onPress={onOpen}
          className={cn(
            "flex cursor-pointer rounded-full bg-transparent p-0",
            FOCUS_RING,
          )}
        >
          {face}
        </Button>
      ) : (
        face
      )}
    </figure>
  );
}

/** A row of phase ticks along one edge. The bottom row is a decorative mirror. */
function PhaseGauge({
  edge,
  currentIdx,
}: {
  edge: "top" | "bottom";
  currentIdx: number;
}) {
  const decorative = edge === "bottom";
  return (
    <div
      aria-hidden={decorative || undefined}
      className={cn(
        "absolute inset-x-[9%] flex",
        edge === "top" ? "top-0" : "bottom-0",
      )}
    >
      {MOON_NAMES.map((name, i) => (
        <PhaseTick
          key={name}
          edge={edge}
          name={name}
          glyph={MOON_GLYPHS[i]}
          current={i === currentIdx}
          decorative={decorative}
        />
      ))}
    </div>
  );
}

function PhaseTick({
  edge,
  name,
  glyph,
  current,
  decorative,
}: {
  edge: "top" | "bottom";
  name: string;
  glyph: string;
  current: boolean;
  decorative: boolean;
}) {
  return (
    <TooltipTrigger delay={250} closeDelay={0}>
      <Button
        aria-label={name}
        aria-current={current ? "true" : undefined}
        excludeFromTabOrder={decorative || undefined}
        className={cn(
          "flex flex-1 cursor-default justify-center bg-transparent p-0 outline-none",
          edge === "top" ? "items-start pt-1" : "items-end pb-1",
        )}
        style={{ height: "12px" }}
      >
        <span
          style={{
            width: "1px",
            height: current ? "10px" : "6px",
            background: current ? "var(--accent)" : "var(--faint)",
          }}
        />
      </Button>
      <Tooltip
        placement={edge}
        offset={4}
        className="z-50 flex items-center gap-1.5 rounded-lg bg-ink px-2.5 py-1 text-[12.5px] text-ground shadow-md"
      >
        <span>{glyph}</span>
        {name}
        {current && <span className="ml-1 font-medium">· now</span>}
      </Tooltip>
    </TooltipTrigger>
  );
}

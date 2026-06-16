import { Button, Tooltip, TooltipTrigger } from "react-aria-components";
import { cn } from "#/lib/cn";
import { MOON_GLYPHS, MOON_NAMES, type MoonInfo } from "./sky";

// Engraved lit face: a warm paper duotone with a halftone stipple, gentle
// upper-right luminosity, and limb darkening — layered as a single background.
const SURFACE_BG = [
  "radial-gradient(circle at 66% 36%, rgba(255,252,244,0.45), rgba(255,252,244,0) 58%)",
  "radial-gradient(rgba(46,43,35,0.42) 0.5px, transparent 0.95px) 0 0 / 3px 3px",
  "radial-gradient(circle at 52% 48%, #ded7c5 58%, #b0a995 100%)",
].join(", ");

/**
 * CSS-drawn moon-phase disc with an "engraved instrument" treatment: a stippled,
 * softly-lit face; a faint halo; and a phase gauge of vertical ticks along the
 * top and bottom edges (one per named phase, current in accent) where each tick
 * names its phase on hover/focus. Phase geometry is driven by {@link MoonInfo}:
 * the disc flips for waning, and the night side is a horizontally-shifted shadow
 * sized by illumination.
 */
export function MoonDisc({ info }: { info: MoonInfo }) {
  const currentIdx = MOON_NAMES.indexOf(info.phaseName);
  return (
    <div
      className="relative flex h-24 w-24 items-center justify-center border border-rule bg-paper"
      style={{ boxShadow: "0 0 22px 1px rgba(206,214,226,0.09)" }}
      aria-label={`${info.phaseName} · ${info.illumPct}%`}
    >
      <PhaseGauge edge="top" currentIdx={currentIdx} />
      <PhaseGauge edge="bottom" currentIdx={currentIdx} />

      <div
        className="relative h-16 w-16 overflow-hidden rounded-full"
        style={{
          boxShadow: "inset 0 0 0 1px #4a463c",
          transform: info.waxing ? "none" : "scaleX(-1)",
        }}
      >
        {/* lit surface */}
        <span
          className="absolute inset-0 rounded-full"
          style={{ background: SURFACE_BG }}
        />
        {/* night side: shadow disc shifted by illumination, softly terminated */}
        <span
          className="absolute inset-0 rounded-full"
          style={{
            background: "#141310",
            filter: "blur(0.5px)",
            transform: `translateX(-${info.illumPct}%)`,
          }}
        />
      </div>
    </div>
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
            background: current ? "var(--accent)" : "var(--ink-mute)",
          }}
        />
      </Button>
      <Tooltip
        placement={edge}
        offset={4}
        className="cl-mono z-50 flex items-center gap-1.5 border border-rule px-2 py-0.5 text-[10px] tracking-[0.08em] text-ink"
        style={{ background: "#15140f", borderLeft: "2px solid var(--accent)" }}
      >
        <span className="text-ink-2">{glyph}</span>
        {name}
        {current && (
          <span className="ml-1.5 text-[8px] tracking-[0.16em] text-accent">
            NOW
          </span>
        )}
      </Tooltip>
    </TooltipTrigger>
  );
}

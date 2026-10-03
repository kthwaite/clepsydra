import { cn } from "#/lib/cn";
import { phaseGlyphPath } from "./calendar";

export interface PhaseGlyphProps {
  illumFraction: number;
  waxing: boolean;
  /** Rendered diameter in px. */
  size?: number;
  className?: string;
}

/** A small flat moon: dark disc with the lit portion drawn over it. */
export function PhaseGlyph({
  illumFraction,
  waxing,
  size = 14,
  className,
}: PhaseGlyphProps) {
  const r = 10;
  const lit = phaseGlyphPath(illumFraction, waxing, r);
  return (
    <svg
      aria-hidden="true"
      data-testid="phase-glyph"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      className={cn("shrink-0", className)}
    >
      <circle cx={r} cy={r} r={r} className="fill-sink" />
      {lit && <path d={lit} className="fill-ink-2" />}
    </svg>
  );
}

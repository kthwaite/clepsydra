import { cn } from "#/lib/cn";
import { phaseGlyphPath } from "./calendar";

export interface PhaseGlyphProps {
  illumFraction: number;
  waxing: boolean;
  /** Rendered diameter in px. */
  size?: number;
  className?: string;
}

// Fixed moon tones, not theme tokens: the glyph depicts the Moon, so the lit
// side stays lighter than the night side on bone and charcoal alike.
const MOON_NIGHT = "#3b3934";
const MOON_LIT = "#cdc8bb";

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
      <circle cx={r} cy={r} r={r} fill={MOON_NIGHT} />
      {lit && <path d={lit} fill={MOON_LIT} />}
    </svg>
  );
}

import { cn } from "#/lib/cn";

// Engraved lit face: a warm paper duotone with a halftone stipple, gentle
// upper-right luminosity, and limb darkening — layered as a single background.
const SURFACE_BG = [
  "radial-gradient(circle at 66% 36%, rgba(255,252,244,0.45), rgba(255,252,244,0) 58%)",
  "radial-gradient(rgba(46,43,35,0.42) 0.5px, transparent 0.95px) 0 0 / 3px 3px",
  "radial-gradient(circle at 52% 48%, #ded7c5 58%, #b0a995 100%)",
].join(", ");

/**
 * CSS-drawn moon phase: a stippled, softly-lit face with a night-side shadow
 * shifted by illumination. The disc flips for waning. The fallback for
 * {@link MoonFace} before its texture loads, or where canvas is unavailable.
 */
export function CssMoon({
  illumPct,
  waxing,
  size,
  className,
}: {
  illumPct: number;
  waxing: boolean;
  size: number;
  className?: string;
}) {
  return (
    <div
      data-css-moon
      className={cn("relative overflow-hidden rounded-full", className)}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        boxShadow: "inset 0 0 0 1px var(--faint)",
        transform: waxing ? "none" : "scaleX(-1)",
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
          transform: `translateX(-${illumPct}%)`,
        }}
      />
    </div>
  );
}

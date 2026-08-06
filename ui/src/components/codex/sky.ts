import SunCalc from "suncalc";

export const MOON_NAMES = [
  "New",
  "Waxing crescent",
  "First quarter",
  "Waxing gibbous",
  "Full",
  "Waning gibbous",
  "Last quarter",
  "Waning crescent",
];
export const MOON_GLYPHS = ["🌑", "🌒", "🌓", "🌔", "🌕", "🌖", "🌗", "🌘"];

export interface MoonInfo {
  phaseName: string;
  glyph: string;
  /** Illuminated fraction, 0..100, rounded. */
  illumPct: number;
  waxing: boolean;
  /** Terminator ellipse scaleX for the CSS disc (0 = half-lit edge, 1 = full). */
  terminatorScaleX: number;
}

/** Pure mapping from raw illumination to display info. */
export function describeMoon(illum: {
  fraction: number;
  phase: number;
}): MoonInfo {
  const idx = Math.round(illum.phase * 8) % 8;
  return {
    phaseName: MOON_NAMES[idx],
    glyph: MOON_GLYPHS[idx],
    illumPct: Math.round(illum.fraction * 100),
    waxing: illum.phase < 0.5,
    // |1 - 2f|: 1 at new/full, 0 at the quarters (straight terminator).
    terminatorScaleX: Math.abs(1 - 2 * illum.fraction),
  };
}

export function moonPhase(now: Date): MoonInfo {
  return describeMoon(SunCalc.getMoonIllumination(now));
}

export function nextLocalDate(date: Date): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  return next;
}

export function selectDisplayedSunrise(
  now: Date,
  todaySunrise: Date,
  todaySunset: Date,
  tomorrowSunrise: () => Date,
): { time: Date; isTomorrow: boolean } {
  if (now.getTime() >= todaySunset.getTime()) {
    return { time: tomorrowSunrise(), isTomorrow: true };
  }
  return { time: todaySunrise, isTomorrow: false };
}

// Day-arc quadratic Bézier control points (matches SPLASH viewBox 0 0 600 56):
// P0 (24,48) → P1 (300,-32) → P2 (576,48).
const P0 = { x: 24, y: 48 };
const P1 = { x: 300, y: -32 };
const P2 = { x: 576, y: 48 };

export function bezierPoint(t: number): { x: number; y: number } {
  const mt = 1 - t;
  return {
    x: Math.round(mt * mt * P0.x + 2 * mt * t * P1.x + t * t * P2.x),
    y: Math.round(mt * mt * P0.y + 2 * mt * t * P1.y + t * t * P2.y),
  };
}

export interface SunArc {
  t: number;
  x: number;
  y: number;
}

/** Sun position along the arc by time-of-day, clamped to [0,1]. */
export function sunArcPosition(now: Date, sunrise: Date, sunset: Date): SunArc {
  const span = sunset.getTime() - sunrise.getTime();
  const raw = span > 0 ? (now.getTime() - sunrise.getTime()) / span : 0;
  const t = Math.min(1, Math.max(0, raw));
  return { t, ...bezierPoint(t) };
}

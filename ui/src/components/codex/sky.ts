import SunCalc from "suncalc";
import { formatDurationHM, formatTimeHM } from "#/lib/time";

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

function moonPhase(now: Date): MoonInfo {
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

/** The derived sky telemetry rendered by the Atrium Sky card. */
export interface SkyData {
  moon: MoonInfo;
  sunrise: string;
  sunriseIsTomorrow: boolean;
  sunset: string;
  lightLeft: string;
  arc: SunArc;
  place: string | null;
}

interface SkyLocation {
  latitude?: number | null;
  longitude?: number | null;
  label?: string | null;
}

export function hasCoords(location: SkyLocation | undefined): boolean {
  return (
    (location?.latitude ?? null) !== null &&
    (location?.longitude ?? null) !== null
  );
}

/** Fixed 06:00–20:00 local sun times used when no vault location is set. */
export function fallbackSunTimes(date: Date): { sunrise: Date; sunset: Date } {
  const at = (h: number) => {
    const d = new Date(date);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  return { sunrise: at(6), sunset: at(20) };
}

/** Full sky telemetry for the Atrium Sky card. */
export function deriveSky(
  now: Date,
  location: SkyLocation | undefined,
): SkyData {
  const lat = location?.latitude ?? null;
  const lon = location?.longitude ?? null;
  const hasLoc = lat !== null && lon !== null;
  const getSunTimes = (date: Date) =>
    hasLoc ? SunCalc.getTimes(date, lat, lon) : fallbackSunTimes(date);
  const times = getSunTimes(now);
  const displayedSunrise = selectDisplayedSunrise(
    now,
    times.sunrise,
    times.sunset,
    () => getSunTimes(nextLocalDate(now)).sunrise,
  );
  const remSec = Math.max(
    0,
    Math.floor((times.sunset.getTime() - now.getTime()) / 1000),
  );
  return {
    moon: moonPhase(now),
    sunrise: formatTimeHM(displayedSunrise.time),
    sunriseIsTomorrow: displayedSunrise.isTomorrow,
    sunset: formatTimeHM(times.sunset),
    lightLeft: formatDurationHM(remSec),
    arc: sunArcPosition(now, times.sunrise, times.sunset),
    place: location?.label ?? null,
  };
}

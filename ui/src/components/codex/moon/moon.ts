import {
  Body,
  GeoMoon,
  Illumination,
  KM_PER_AU,
  MoonPhase,
  NextMoonQuarter,
  Observer,
  SearchMoonPhase,
  SearchMoonQuarter,
  SearchRiseSet,
} from "astronomy-engine";
import { MOON_GLYPHS, MOON_NAMES } from "#/components/codex/sky";

export interface MoonLocation {
  latitude: number;
  longitude: number;
}

export interface MoonState {
  phaseName: string;
  glyph: string;
  /** Lunar age as a fraction of the synodic cycle: 0 = new, 0.5 = full. */
  phase: number;
  /** Illuminated fraction of the disc, 0..1. */
  illumFraction: number;
  /** Illuminated fraction, 0..100, rounded. */
  illumPct: number;
  waxing: boolean;
  /** Geocentric Earth–Moon centre distance. */
  distanceKm: number;
  /** Moonrise during the local day containing the instant; null without a location or event. */
  rise: Date | null;
  /** Moonset during the local day containing the instant; null without a location or event. */
  set: Date | null;
  nextFull: Date;
  nextNew: Date;
}

export type MoonEventKind = "new" | "first" | "full" | "last";

export interface MoonEvent {
  kind: MoonEventKind;
  date: Date;
}

export interface MoonDay {
  /** Local noon of the day. */
  date: Date;
  phase: number;
  illumFraction: number;
  waxing: boolean;
}

export interface MonthPhases {
  days: MoonDay[];
  events: MoonEvent[];
}

/** Longer than one synodic month (~29.53 days), so a search always succeeds. */
const PHASE_SEARCH_DAYS = 40;
const QUARTER_KINDS: MoonEventKind[] = ["new", "first", "full", "last"];

function phaseAt(date: Date): {
  phase: number;
  illumFraction: number;
  waxing: boolean;
} {
  const phase = (MoonPhase(date) / 360) % 1;
  return {
    phase,
    illumFraction: Illumination(Body.Moon, date).phase_fraction,
    waxing: phase < 0.5,
  };
}

function nextPhase(targetLon: number, from: Date): Date {
  const found = SearchMoonPhase(targetLon, from, PHASE_SEARCH_DAYS);
  if (!found) throw new Error(`no moon phase ${targetLon}° after ${from}`);
  return found.date;
}

function localDayBounds(date: Date): { start: Date; end: Date } {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start, end };
}

/** First rise (+1) or set (-1) in the local day containing `date`. */
function riseSetInDay(
  date: Date,
  loc: MoonLocation,
  direction: 1 | -1,
): Date | null {
  const { start, end } = localDayBounds(date);
  const observer = new Observer(loc.latitude, loc.longitude, 0);
  const found = SearchRiseSet(Body.Moon, observer, direction, start, 1);
  if (!found || found.date.getTime() >= end.getTime()) return null;
  return found.date;
}

/** The Moon's state at an instant, optionally for an observer location. */
export function moonAt(date: Date, loc?: MoonLocation | null): MoonState {
  const { phase, illumFraction, waxing } = phaseAt(date);
  const idx = Math.round(phase * 8) % 8;
  return {
    phaseName: MOON_NAMES[idx],
    glyph: MOON_GLYPHS[idx],
    phase,
    illumFraction,
    illumPct: Math.round(illumFraction * 100),
    waxing,
    distanceKm: GeoMoon(date).Length() * KM_PER_AU,
    rise: loc ? riseSetInDay(date, loc, 1) : null,
    set: loc ? riseSetInDay(date, loc, -1) : null,
    nextFull: nextPhase(180, date),
    nextNew: nextPhase(0, date),
  };
}

/** Per-day phases (at local noon) and quarter events for a local month. */
export function monthPhases(year: number, monthIndex0: number): MonthPhases {
  const start = new Date(year, monthIndex0, 1);
  const end = new Date(year, monthIndex0 + 1, 1);
  const days: MoonDay[] = [];
  for (
    let day = new Date(year, monthIndex0, 1, 12);
    day < end;
    day = new Date(year, monthIndex0, day.getDate() + 1, 12)
  ) {
    days.push({ date: day, ...phaseAt(day) });
  }
  const events: MoonEvent[] = [];
  for (
    let q = SearchMoonQuarter(start);
    q.time.date < end;
    q = NextMoonQuarter(q)
  ) {
    events.push({ kind: QUARTER_KINDS[q.quarter], date: q.time.date });
  }
  return { days, events };
}

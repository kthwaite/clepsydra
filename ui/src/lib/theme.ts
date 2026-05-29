// VESSEL theme + operator-preference state.
//
// Dark is the base palette (defined on :root with no class), so dark renders
// with zero classes and no FOUC. Light ("paper") mode is opt-in via a `.paper`
// class on <html>. Accent / density / diegetic-chrome are applied as
// data-attributes on <html> and consumed by main.css.

export type ThemeMode = "light" | "dark" | "system";

export type Accent =
  | "barbican"
  | "alert"
  | "amber"
  | "cyan"
  | "phosphor"
  | "bone";

export type Density = "compact" | "default" | "spacious";

export const ACCENTS: { id: Accent; label: string }[] = [
  { id: "barbican", label: "BARBICAN-ORG" },
  { id: "alert", label: "ALERT-RED" },
  { id: "amber", label: "AMBER-CRT" },
  { id: "cyan", label: "RADAR-CYAN" },
  { id: "phosphor", label: "PHOSPHOR-GR" },
  { id: "bone", label: "BONE-WHITE" },
];

export const DENSITIES: Density[] = ["compact", "default", "spacious"];

export const THEME_STORAGE_KEY = "clepsydra.theme";
export const ACCENT_STORAGE_KEY = "clepsydra.accent";
export const DENSITY_STORAGE_KEY = "clepsydra.density";
export const DIEGETIC_STORAGE_KEY = "clepsydra.diegetic";

// Dark is the resting default (decision: dark-default Vessel).
const DEFAULT_THEME: ThemeMode = "dark";
const DEFAULT_ACCENT: Accent = "barbican";
const DEFAULT_DENSITY: Density = "default";
const DEFAULT_DIEGETIC = true;

export function getSystemTheme(): Exclude<ThemeMode, "system"> {
  if (typeof window === "undefined") return "dark";
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function resolveTheme(mode: ThemeMode): Exclude<ThemeMode, "system"> {
  return mode === "system" ? getSystemTheme() : mode;
}

function read<T extends string>(
  key: string,
  valid: readonly T[],
  fallback: T,
): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw && (valid as readonly string[]).includes(raw)) return raw as T;
  } catch {
    // ignore
  }
  return fallback;
}

export function readStoredTheme(): ThemeMode {
  return read(THEME_STORAGE_KEY, ["light", "dark", "system"], DEFAULT_THEME);
}

export function readStoredAccent(): Accent {
  return read(
    ACCENT_STORAGE_KEY,
    ACCENTS.map((a) => a.id),
    DEFAULT_ACCENT,
  );
}

export function readStoredDensity(): Density {
  return read(DENSITY_STORAGE_KEY, DENSITIES, DEFAULT_DENSITY);
}

export function readStoredDiegetic(): boolean {
  if (typeof window === "undefined") return DEFAULT_DIEGETIC;
  try {
    const raw = window.localStorage.getItem(DIEGETIC_STORAGE_KEY);
    if (raw === "on") return true;
    if (raw === "off") return false;
  } catch {
    // ignore
  }
  return DEFAULT_DIEGETIC;
}

function store(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

export const storeTheme = (mode: ThemeMode) => store(THEME_STORAGE_KEY, mode);
export const storeAccent = (a: Accent) => store(ACCENT_STORAGE_KEY, a);
export const storeDensity = (d: Density) => store(DENSITY_STORAGE_KEY, d);
export const storeDiegetic = (on: boolean) =>
  store(DIEGETIC_STORAGE_KEY, on ? "on" : "off");

export function applyThemeClass(resolved: Exclude<ThemeMode, "system">) {
  const root = document.documentElement;
  // Dark is the base palette → light adds `.paper`.
  root.classList.toggle("paper", resolved === "light");
  root.style.colorScheme = resolved;
}

export function applyAccent(accent: Accent) {
  const root = document.documentElement;
  if (accent === DEFAULT_ACCENT) root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", accent);
}

export function applyDensity(density: Density) {
  const root = document.documentElement;
  if (density === DEFAULT_DENSITY) root.removeAttribute("data-density");
  else root.setAttribute("data-density", density);
}

export function applyDiegetic(on: boolean) {
  const root = document.documentElement;
  // Default (on) carries no attribute; `off` hides diegetic chrome via CSS.
  if (on) root.removeAttribute("data-diegetic");
  else root.setAttribute("data-diegetic", "off");
}

import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  type Accent,
  applyAccent,
  applyDensity,
  applyDiegetic,
  applyThemeClass,
  type Density,
  readStoredAccent,
  readStoredDensity,
  readStoredDiegetic,
  readStoredTheme,
  resolveTheme,
  storeAccent,
  storeDensity,
  storeDiegetic,
  storeTheme,
  type ThemeMode,
} from "#/lib/theme";

type ThemeContextValue = {
  mode: ThemeMode;
  resolvedTheme: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
  accent: Accent;
  setAccent: (accent: Accent) => void;
  density: Density;
  setDensity: (density: Density) => void;
  diegetic: boolean;
  setDiegetic: (on: boolean) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    resolveTheme(readStoredTheme()),
  );
  const [accent, setAccentState] = useState<Accent>(() => readStoredAccent());
  const [density, setDensityState] = useState<Density>(() =>
    readStoredDensity(),
  );
  const [diegetic, setDiegeticState] = useState<boolean>(() =>
    readStoredDiegetic(),
  );

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    storeTheme(next);
  }, []);

  const toggle = useCallback(() => {
    setMode(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setMode]);

  const setAccent = useCallback((next: Accent) => {
    setAccentState(next);
    storeAccent(next);
  }, []);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    storeDensity(next);
  }, []);

  const setDiegetic = useCallback((on: boolean) => {
    setDiegeticState(on);
    storeDiegetic(on);
  }, []);

  useEffect(() => {
    const resolved = resolveTheme(mode);
    setResolvedTheme(resolved);
    applyThemeClass(resolved);
  }, [mode]);

  useEffect(() => applyAccent(accent), [accent]);
  useEffect(() => applyDensity(density), [density]);
  useEffect(() => applyDiegetic(diegetic), [diegetic]);

  useEffect(() => {
    if (mode !== "system") return;

    const media = window.matchMedia?.("(prefers-color-scheme: light)");
    if (!media) return;

    const onChange = () => {
      const resolved = resolveTheme("system");
      setResolvedTheme(resolved);
      applyThemeClass(resolved);
    };

    onChange();

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }

    // Safari
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, [mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      resolvedTheme,
      setMode,
      toggle,
      accent,
      setAccent,
      density,
      setDensity,
      diegetic,
      setDiegetic,
    }),
    [
      mode,
      resolvedTheme,
      setMode,
      toggle,
      accent,
      setAccent,
      density,
      setDensity,
      diegetic,
      setDiegetic,
    ],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return ctx;
}

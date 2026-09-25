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
  applyDensity,
  applyThemeClass,
  clearLegacyAccent,
  clearLegacyDiegetic,
  type Density,
  readStoredDensity,
  readStoredTheme,
  resolveTheme,
  storeDensity,
  storeTheme,
  type ThemeMode,
} from "#/lib/theme";

type ThemeContextValue = {
  mode: ThemeMode;
  resolvedTheme: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
  density: Density;
  setDensity: (density: Density) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const [mode, setModeState] = useState<ThemeMode>(() => readStoredTheme());
  const [resolvedTheme, setResolvedTheme] = useState<"light" | "dark">(() =>
    resolveTheme(readStoredTheme()),
  );
  const [density, setDensityState] = useState<Density>(() =>
    readStoredDensity(),
  );

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    storeTheme(next);
  }, []);

  const toggle = useCallback(() => {
    setMode(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setMode]);

  const setDensity = useCallback((next: Density) => {
    setDensityState(next);
    storeDensity(next);
  }, []);

  useEffect(() => {
    const resolved = resolveTheme(mode);
    setResolvedTheme(resolved);
    applyThemeClass(resolved);
  }, [mode]);

  useEffect(() => {
    clearLegacyAccent();
    clearLegacyDiegetic();
  }, []);
  useEffect(() => applyDensity(density), [density]);

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
      density,
      setDensity,
    }),
    [mode, resolvedTheme, setMode, toggle, density, setDensity],
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

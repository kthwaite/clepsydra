import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeClass,
  readStoredTheme,
  THEME_COLOR,
  THEME_STORAGE_KEY,
} from "#/lib/theme";

function fakeStorage(seed: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(seed));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => {
      map.delete(k);
    },
    setItem: (k, v) => {
      map.set(k, String(v));
    },
  };
}

const meta = () =>
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');

beforeEach(() => {
  document.documentElement.className = "";
  meta()?.remove();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("theme defaults", () => {
  it("defaults to light (bone) when nothing is stored", () => {
    vi.stubGlobal("localStorage", fakeStorage());
    expect(readStoredTheme()).toBe("light");
  });

  it("respects a stored Vessel-era dark preference", () => {
    vi.stubGlobal("localStorage", fakeStorage({ [THEME_STORAGE_KEY]: "dark" }));
    expect(readStoredTheme()).toBe("dark");
  });

  it("respects a stored system preference", () => {
    vi.stubGlobal(
      "localStorage",
      fakeStorage({ [THEME_STORAGE_KEY]: "system" }),
    );
    expect(readStoredTheme()).toBe("system");
  });
});

describe("applyThemeClass", () => {
  it("adds .paper and bone theme-color for light", () => {
    applyThemeClass("light");
    expect(document.documentElement.classList.contains("paper")).toBe(true);
    expect(meta()?.content).toBe(THEME_COLOR.light);
    expect(THEME_COLOR.light).toBe("#F4EFE4");
  });

  it("removes .paper and sets charcoal theme-color for dark", () => {
    applyThemeClass("light");
    applyThemeClass("dark");
    expect(document.documentElement.classList.contains("paper")).toBe(false);
    expect(meta()?.content).toBe(THEME_COLOR.dark);
    expect(THEME_COLOR.dark).toBe("#151412");
  });

  it("updates an existing meta tag rather than adding a second", () => {
    const tag = document.createElement("meta");
    tag.name = "theme-color";
    tag.content = "#efece2";
    document.head.append(tag);
    applyThemeClass("dark");
    expect(document.querySelectorAll('meta[name="theme-color"]')).toHaveLength(
      1,
    );
    expect(tag.content).toBe("#151412");
  });
});

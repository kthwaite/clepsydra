import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  compactDefault,
  tableCompactKey,
  useTableCompact,
} from "#/hooks/useTableCompact";

beforeEach(() => localStorage.clear());

describe("compactDefault", () => {
  it("follows the compact and spacious presets, else the screen's default", () => {
    expect(compactDefault("compact", false)).toBe(true);
    expect(compactDefault("spacious", true)).toBe(false);
    expect(compactDefault("default", true)).toBe(true);
    expect(compactDefault("default", false)).toBe(false);
  });
});

describe("useTableCompact", () => {
  it("starts from the screen default under the default preset", () => {
    const { result } = renderHook(() => useTableCompact("gazetteer", true));
    expect(result.current[0]).toBe(true);
  });

  it("starts from the global preset when nothing is stored", () => {
    localStorage.setItem("clepsydra.density", "spacious");
    const { result } = renderHook(() => useTableCompact("gazetteer", true));
    expect(result.current[0]).toBe(false);
  });

  it("persists a choice per screen", () => {
    const { result, unmount } = renderHook(() =>
      useTableCompact("gazetteer", true),
    );
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(tableCompactKey("gazetteer"))).toBe("false");
    unmount();
    const again = renderHook(() => useTableCompact("gazetteer", true));
    expect(again.result.current[0]).toBe(false);
    const other = renderHook(() => useTableCompact("bases", false));
    expect(other.result.current[0]).toBe(false);
  });

  it("ignores a corrupt stored value", () => {
    localStorage.setItem(tableCompactKey("gazetteer"), "maybe");
    const { result } = renderHook(() => useTableCompact("gazetteer", true));
    expect(result.current[0]).toBe(true);
  });
});

import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { useColumnWidths } from "#/components/bases/useColumnWidths";

const KEY = "clepsydra.bases.columns.reading.shelf";
const OTHER = "clepsydra.bases.columns.reading.continues";

describe("useColumnWidths", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("sets, clamps, and deletes widths", () => {
    const { result } = renderHook(() => useColumnWidths(KEY));
    expect(result.current.widths).toEqual({});
    act(() => result.current.setWidth("status", 150.4));
    expect(result.current.widths).toEqual({ status: 150 });
    act(() => result.current.setWidth("rating", 2));
    expect(result.current.widths).toEqual({ status: 150, rating: 40 });
    act(() => result.current.setWidth("status", undefined));
    expect(result.current.widths).toEqual({ rating: 40 });
  });

  it("persists widths and restores them on the next mount", () => {
    const first = renderHook(() => useColumnWidths(KEY));
    act(() => first.result.current.setWidth("status", 200));
    expect(window.localStorage.getItem(KEY)).toBe('{"status":200}');
    first.unmount();
    const second = renderHook(() => useColumnWidths(KEY));
    expect(second.result.current.widths).toEqual({ status: 200 });
  });

  it("removes the stored entry when the last width is reset", () => {
    const { result } = renderHook(() => useColumnWidths(KEY));
    act(() => result.current.setWidth("status", 200));
    act(() => result.current.setWidth("status", undefined));
    expect(window.localStorage.getItem(KEY)).toBeNull();
    expect(result.current.widths).toEqual({});
  });

  it("reads the other key's widths when the key changes", () => {
    window.localStorage.setItem(OTHER, '{"kind":90}');
    const { result, rerender } = renderHook(({ key }) => useColumnWidths(key), {
      initialProps: { key: KEY },
    });
    act(() => result.current.setWidth("status", 200));
    rerender({ key: OTHER });
    expect(result.current.widths).toEqual({ kind: 90 });
    act(() => result.current.setWidth("rating", 70));
    expect(result.current.widths).toEqual({ kind: 90, rating: 70 });
    expect(window.localStorage.getItem(OTHER)).toBe('{"kind":90,"rating":70}');
    rerender({ key: KEY });
    expect(result.current.widths).toEqual({ status: 200 });
  });

  it("keeps the same map identity when a change is a no-op", () => {
    const { result } = renderHook(() => useColumnWidths(KEY));
    act(() => result.current.setWidth("status", 200));
    const before = result.current.widths;
    act(() => result.current.setWidth("status", 200));
    act(() => result.current.setWidth("never-set", undefined));
    expect(result.current.widths).toBe(before);
  });

  it("writes through idempotently under StrictMode", () => {
    const { result } = renderHook(() => useColumnWidths(KEY), {
      wrapper: StrictMode,
    });
    act(() => result.current.setWidth("status", 200));
    expect(result.current.widths).toEqual({ status: 200 });
    expect(window.localStorage.getItem(KEY)).toBe('{"status":200}');
  });
});

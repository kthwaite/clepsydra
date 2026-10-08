import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMediaQuery } from "#/hooks/useMediaQuery";

/** A matchMedia whose answers follow a settable viewport width. */
function installWidth(initial: number) {
  let width = initial;
  const listeners = new Set<() => void>();
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      media: query,
      get matches() {
        const min = /min-width:\s*(\d+)px/.exec(query);
        return min ? width >= Number(min[1]) : false;
      },
      addEventListener: (_type: "change", listener: () => void) =>
        listeners.add(listener),
      removeEventListener: (_type: "change", listener: () => void) =>
        listeners.delete(listener),
    })),
  );
  return (next: number) => {
    width = next;
    act(() => {
      for (const listener of listeners) listener();
    });
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("useMediaQuery", () => {
  it("follows the query as it starts and stops matching", () => {
    const setWidth = installWidth(1300);
    const { result, unmount } = renderHook(() =>
      useMediaQuery("(min-width: 1280px)"),
    );
    expect(result.current).toBe(true);
    setWidth(1000);
    expect(result.current).toBe(false);
    unmount();
  });

  it("is false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(
      renderHook(() => useMediaQuery("(min-width: 1px)")).result.current,
    ).toBe(false);
  });
});

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MOBILE_LAYOUT_QUERY, useMobileLayout } from "#/hooks/useMobileLayout";

function installMatchMedia(initial: boolean) {
  let matches = initial;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  vi.stubGlobal("matchMedia", vi.fn((query: string) => ({
    media: query,
    get matches() { return matches; },
    onchange: null,
    addEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: "change", listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
  })));
  return (next: boolean) => {
    matches = next;
    act(() => listeners.forEach((listener) => listener({ matches: next, media: MOBILE_LAYOUT_QUERY } as MediaQueryListEvent)));
  };
}

describe("useMobileLayout", () => {
  it("tracks the shared 768px boundary", () => {
    const setMobile = installMatchMedia(false);
    const { result, unmount } = renderHook(() => useMobileLayout());
    expect(matchMedia).toHaveBeenCalledWith(MOBILE_LAYOUT_QUERY);
    expect(result.current).toBe(false);
    setMobile(true);
    expect(result.current).toBe(true);
    unmount();
  });

  it("defaults to desktop without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(renderHook(() => useMobileLayout()).result.current).toBe(false);
  });
});

import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElementHeight } from "#/hooks/useElementHeight";

let fire: (() => void) | undefined;
let height = 300;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        fire = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () => ({ height }) as DOMRect,
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function Probe({ onHeight }: { onHeight: (h: number | null) => void }) {
  const [ref, h] = useElementHeight<HTMLDivElement>();
  onHeight(h);
  return <div ref={ref} />;
}

describe("useElementHeight", () => {
  it("measures on attach, then settles resizes after a debounce", () => {
    const seen: Array<number | null> = [];
    render(<Probe onHeight={(h) => seen.push(h)} />);
    expect(seen.at(-1)).toBe(300);

    height = 500;
    act(() => {
      fire?.();
      fire?.();
      vi.advanceTimersByTime(100);
    });
    expect(seen.at(-1)).toBe(300);
    act(() => vi.advanceTimersByTime(60));
    expect(seen.at(-1)).toBe(500);
  });

  it("re-measures at once on request, skipping the debounce", () => {
    let api: [unknown, number | null, () => void] | undefined;
    function Remeasure() {
      const [ref, h, remeasure] = useElementHeight<HTMLDivElement>();
      api = [ref, h, remeasure];
      return <div ref={ref} />;
    }
    height = 300;
    render(<Remeasure />);
    height = 420;
    act(() => api?.[2]());
    expect(api?.[1]).toBe(420);
  });
});

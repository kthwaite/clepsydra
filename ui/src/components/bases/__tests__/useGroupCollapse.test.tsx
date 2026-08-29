import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGroupCollapse } from "#/components/bases/useGroupCollapse";

const KEY = "clepsydra.bases.groups.reading.shelf.status";

describe("useGroupCollapse", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("toggles, expands, and folds everything", () => {
    const { result } = renderHook(() => useGroupCollapse(KEY));
    expect(result.current.collapsed.size).toBe(0);
    act(() => result.current.toggle('"reading"'));
    expect([...result.current.collapsed]).toEqual(['"reading"']);
    act(() => result.current.toggle('"reading"'));
    expect(result.current.collapsed.size).toBe(0);
    act(() => result.current.collapseAll(['"reading"', '"queued"']));
    expect([...result.current.collapsed]).toEqual(['"reading"', '"queued"']);
    act(() => result.current.expand('"queued"'));
    expect([...result.current.collapsed]).toEqual(['"reading"']);
    act(() => result.current.expandAll());
    expect(result.current.collapsed.size).toBe(0);
  });

  it("persists the fold and restores it on the next mount", () => {
    const first = renderHook(() => useGroupCollapse(KEY));
    act(() => first.result.current.toggle('"reading"'));
    expect(window.localStorage.getItem(KEY)).toBe('["\\"reading\\""]');
    first.unmount();
    const second = renderHook(() => useGroupCollapse(KEY));
    expect([...second.result.current.collapsed]).toEqual(['"reading"']);
  });

  it("reads the other key's fold when the key changes", () => {
    window.localStorage.setItem(
      "clepsydra.bases.groups.reading.continues.kind",
      '["\\"BOOK\\""]',
    );
    const { result, rerender } = renderHook(
      ({ key }) => useGroupCollapse(key),
      { initialProps: { key: KEY } },
    );
    act(() => result.current.toggle('"reading"'));
    rerender({ key: "clepsydra.bases.groups.reading.continues.kind" });
    expect([...result.current.collapsed]).toEqual(['"BOOK"']);
    act(() => result.current.toggle('"NOTE"'));
    expect([...result.current.collapsed]).toEqual(['"BOOK"', '"NOTE"']);
    rerender({ key: KEY });
    expect([...result.current.collapsed]).toEqual(['"reading"']);
  });

  it("keeps the same set identity when a transition changes nothing", () => {
    const { result } = renderHook(() => useGroupCollapse(KEY));
    const before = result.current.collapsed;
    act(() => result.current.expand('"never-folded"'));
    expect(result.current.collapsed).toBe(before);
  });
});

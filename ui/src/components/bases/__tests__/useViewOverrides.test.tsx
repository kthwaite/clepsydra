import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useViewOverrides } from "#/components/bases/useViewOverrides";

describe("useViewOverrides", () => {
  it("accumulates overrides and resets when the key changes", () => {
    const { result, rerender } = renderHook(
      ({ key }) => useViewOverrides(key),
      {
        initialProps: { key: "reading:continues" },
      },
    );
    act(() => {
      result.current.addQuickFilter({
        field: "status",
        op: "eq",
        value: "reading",
        label: "status is reading",
      });
      result.current.setGroup({ kind: "by", field: "status" });
      result.current.hideColumn("rating");
    });
    expect(result.current.state.quickFilters).toHaveLength(1);
    expect(result.current.state.group).toEqual({ kind: "by", field: "status" });
    expect(result.current.state.hiddenColumns).toEqual(["rating"]);

    rerender({ key: "reading:shelf" });
    expect(result.current.state.quickFilters).toEqual([]);
    expect(result.current.state.group).toBeUndefined();
    expect(result.current.state.hiddenColumns).toEqual([]);
  });

  it("shows one hidden column again", () => {
    const { result } = renderHook(() => useViewOverrides("k"));
    act(() => {
      result.current.hideColumn("author");
      result.current.hideColumn("rating");
      result.current.showColumn("author");
    });
    expect(result.current.state.hiddenColumns).toEqual(["rating"]);
  });

  it("clears everything on demand", () => {
    const { result } = renderHook(() => useViewOverrides("k"));
    act(() => {
      result.current.hideColumn("author");
      result.current.setGroup({ kind: "flat" });
      result.current.clear();
    });
    expect(result.current.state.hiddenColumns).toEqual([]);
    expect(result.current.state.group).toBeUndefined();
  });

  it("reorders columns against the base order and resets the order", () => {
    const base = ["title", "author", "rating"];
    const { result, rerender } = renderHook(
      ({ key }) => useViewOverrides(key),
      { initialProps: { key: "k" } },
    );
    act(() =>
      result.current.reorderColumns(["title", "rating", "author"], base),
    );
    expect(result.current.state.columnOrder).toEqual([
      "title",
      "rating",
      "author",
    ]);
    act(() => result.current.reorderColumns(base, base));
    expect(result.current.state.columnOrder).toBeUndefined();
    act(() =>
      result.current.reorderColumns(["title", "rating", "author"], base),
    );
    act(() => result.current.resetColumnOrder());
    expect(result.current.state.columnOrder).toBeUndefined();
    act(() =>
      result.current.reorderColumns(["title", "rating", "author"], base),
    );
    rerender({ key: "other" });
    expect(result.current.state.columnOrder).toBeUndefined();
  });
});

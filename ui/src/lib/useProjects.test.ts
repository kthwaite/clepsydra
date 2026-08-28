import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { usePagesMock } = vi.hoisted(() => ({ usePagesMock: vi.fn() }));
vi.mock("#/api/pages", () => ({ usePages: usePagesMock }));

import {
  declaredProjects,
  distinctProjects,
  useProjects,
  useProjectValues,
} from "#/lib/useProjects";

const vault = [
  { kind: "PROJECT", project: "clep" },
  { kind: "NOTE", project: "orphan" },
  { kind: "PROJECT", project: "atlas" },
  { kind: "TASK", project: "clep" },
  { kind: "PROJECT", project: "clep" },
  { kind: "PROJECT", project: null },
  { kind: "PROJECT", project: "" },
  { kind: "PROJECT" },
  { kind: "NOTE" },
];

beforeEach(() => {
  vi.clearAllMocks();
  usePagesMock.mockReturnValue({ data: { items: vault } });
});

describe("distinctProjects", () => {
  it("collects sorted unique non-empty project slugs", () => {
    const items = [
      { project: "clep" },
      { project: null },
      { project: "atlas" },
      { project: "clep" },
      {},
    ];
    expect(distinctProjects(items)).toEqual(["atlas", "clep"]);
  });
});

describe("declaredProjects", () => {
  it("collects the sorted unique slugs PROJECT pages declare", () => {
    expect(declaredProjects(vault)).toEqual(["atlas", "clep"]);
  });

  it("ignores slugs only non-PROJECT pages carry", () => {
    expect(
      declaredProjects([
        { kind: "NOTE", project: "orphan" },
        { kind: "TASK", project: "atlas" },
      ]),
    ).toEqual([]);
  });
});

describe("useProjects", () => {
  it("returns the slugs PROJECT pages declare", () => {
    const { result } = renderHook(() => useProjects());
    expect(result.current).toEqual(["atlas", "clep"]);
  });

  it("returns nothing while pages are loading", () => {
    usePagesMock.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useProjects());
    expect(result.current).toEqual([]);
  });
});

describe("useProjectValues", () => {
  it("returns every distinct project value pages carry, orphans included", () => {
    const { result } = renderHook(() => useProjectValues());
    expect(result.current).toEqual(["atlas", "clep", "orphan"]);
  });

  it("returns nothing while pages are loading", () => {
    usePagesMock.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useProjectValues());
    expect(result.current).toEqual([]);
  });
});

import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "#/api/schema";
import {
  useWikilinkResolution,
  WikilinkResolutionProvider,
} from "../wikilinkResolution";

type OutlinkEntry = components["schemas"]["OutlinkEntry"];

const { useOutlinksMock, refetchMock } = vi.hoisted(() => ({
  useOutlinksMock: vi.fn(),
  refetchMock: vi.fn(),
}));

vi.mock("#/api/outlinks", () => ({
  useOutlinks: useOutlinksMock,
}));

function entry(
  targetRaw: string,
  targetPath: string | null,
  kind = "wiki",
): OutlinkEntry {
  return {
    kind,
    source_field: null,
    target_id: targetPath ? "0195e9aa-0000-7000-8000-000000000001" : null,
    target_path: targetPath,
    target_raw: targetRaw,
  };
}

// TanStack Query result objects are unstable per render — return a fresh
// object on every call, keeping only .refetch identity stable (which the
// real library guarantees).
function mockOutlinks(data: OutlinkEntry[] | undefined) {
  useOutlinksMock.mockImplementation(() => ({ data, refetch: refetchMock }));
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <WikilinkResolutionProvider path="notes/source.md">
      {children}
    </WikilinkResolutionProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  refetchMock.mockResolvedValue({ data: undefined });
});

describe("WikilinkResolutionProvider lookup", () => {
  it("passes the page path to useOutlinks", () => {
    mockOutlinks([]);
    renderHook(() => useWikilinkResolution(), { wrapper });
    expect(useOutlinksMock).toHaveBeenCalledWith("notes/source.md");
  });

  it("resolves wiki entries to their target path", () => {
    mockOutlinks([
      entry("Clepsydra Design Notes", "notes/clepsydra-design.md"),
    ]);
    const { result } = renderHook(() => useWikilinkResolution(), { wrapper });
    expect(result.current.lookup("Clepsydra Design Notes")).toBe(
      "notes/clepsydra-design.md",
    );
  });

  it("returns null for unknown targets", () => {
    mockOutlinks([entry("Known", "notes/known.md")]);
    const { result } = renderHook(() => useWikilinkResolution(), { wrapper });
    expect(result.current.lookup("Unknown")).toBeNull();
  });

  it("ignores non-wiki entries even when they carry a target path", () => {
    mockOutlinks([
      entry("Prop Target", "notes/prop-target.md", "property_ref"),
      entry("Tag Target", "notes/tag-target.md", "tag"),
      entry("Block Target", "notes/block-target.md", "block_ref"),
    ]);
    const { result } = renderHook(() => useWikilinkResolution(), { wrapper });
    expect(result.current.lookup("Prop Target")).toBeNull();
    expect(result.current.lookup("Tag Target")).toBeNull();
    expect(result.current.lookup("Block Target")).toBeNull();
  });

  it("treats wiki entries with a null target path as misses", () => {
    mockOutlinks([entry("Dangling Link", null)]);
    const { result } = renderHook(() => useWikilinkResolution(), { wrapper });
    expect(result.current.lookup("Dangling Link")).toBeNull();
  });

  it("returns null while outlinks data is not yet loaded", () => {
    mockOutlinks(undefined);
    const { result } = renderHook(() => useWikilinkResolution(), { wrapper });
    expect(result.current.lookup("Anything")).toBeNull();
  });
});

describe("WikilinkResolutionProvider refetchAndLookup", () => {
  it("refetches exactly once and resolves from the refreshed data", async () => {
    mockOutlinks([]);
    refetchMock.mockResolvedValue({
      data: [entry("Fresh Page", "notes/fresh-page.md")],
    });
    const { result } = renderHook(() => useWikilinkResolution(), { wrapper });

    // Stale state misses; the refreshed result must be consulted directly.
    expect(result.current.lookup("Fresh Page")).toBeNull();
    await expect(result.current.refetchAndLookup("Fresh Page")).resolves.toBe(
      "notes/fresh-page.md",
    );
    expect(refetchMock).toHaveBeenCalledTimes(1);
  });

  it("resolves null when the refreshed data still misses", async () => {
    mockOutlinks([]);
    refetchMock.mockResolvedValue({
      data: [
        entry("Other Page", "notes/other-page.md"),
        entry("Still Dangling", null),
        entry("Prop Target", "notes/prop-target.md", "property_ref"),
      ],
    });
    const { result } = renderHook(() => useWikilinkResolution(), { wrapper });

    await expect(
      result.current.refetchAndLookup("Still Dangling"),
    ).resolves.toBeNull();
    await expect(
      result.current.refetchAndLookup("Prop Target"),
    ).resolves.toBeNull();
  });
});

describe("useWikilinkResolution without a provider", () => {
  it("lookup is a safe no-op returning null", () => {
    const { result } = renderHook(() => useWikilinkResolution());
    expect(result.current.lookup("Anything")).toBeNull();
  });

  it("refetchAndLookup resolves null without touching the query", async () => {
    const { result } = renderHook(() => useWikilinkResolution());
    await expect(
      result.current.refetchAndLookup("Anything"),
    ).resolves.toBeNull();
    expect(refetchMock).not.toHaveBeenCalled();
  });
});

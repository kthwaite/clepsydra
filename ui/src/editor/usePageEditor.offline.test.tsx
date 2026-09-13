import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  usePageMock,
  useUpdatePageMock,
  mutateAsyncMock,
  refetchPageMock,
  useOnlineStatusMock,
} = vi.hoisted(() => ({
  usePageMock: vi.fn(),
  useUpdatePageMock: vi.fn(),
  mutateAsyncMock: vi.fn(),
  refetchPageMock: vi.fn(),
  useOnlineStatusMock: vi.fn(() => true),
}));

vi.mock("#/api/pages", () => ({
  usePage: usePageMock,
  useUpdatePage: useUpdatePageMock,
}));
vi.mock("#/hooks/useOnlineStatus", () => ({
  useOnlineStatus: useOnlineStatusMock,
}));

import { usePageEditor } from "./usePageEditor";

function makePage() {
  return {
    path: "notes/a.md",
    canonical_name: "a",
    body: "Hello\n",
    revision: "rev-a",
    kind: "NOTE",
    inferred: true,
    project: null,
    readonly: false,
    meta: {
      id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62",
      title: null,
      tags: [],
      aliases: [],
    },
  };
}

describe("usePageEditor offline", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useOnlineStatusMock.mockReturnValue(true);
    usePageMock.mockReturnValue({
      data: makePage(),
      isLoading: false,
      error: null,
      refetch: refetchPageMock,
    });
    refetchPageMock.mockResolvedValue({ data: makePage() });
    mutateAsyncMock.mockResolvedValue(makePage());
    useUpdatePageMock.mockReturnValue({ mutateAsync: mutateAsyncMock });
  });

  it("is writable online and forces read-only once the device goes offline", () => {
    const { result, rerender } = renderHook(() => usePageEditor("notes/a.md"));

    expect(result.current.readonly).toBe(false);
    expect(result.current.offline).toBe(false);

    useOnlineStatusMock.mockReturnValue(false);
    rerender();

    expect(result.current.readonly).toBe(true);
    expect(result.current.offline).toBe(true);
  });

  it("stays read-only offline even when the page itself is not protected", () => {
    useOnlineStatusMock.mockReturnValue(false);
    const { result } = renderHook(() => usePageEditor("notes/a.md"));

    expect(result.current.readonly).toBe(true);
    expect(result.current.offline).toBe(true);
  });
});

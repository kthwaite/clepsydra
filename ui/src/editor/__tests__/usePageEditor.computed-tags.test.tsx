import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePageEditor } from "../usePageEditor";

const { usePageMock, useUpdatePageMock, mutateAsyncMock } = vi.hoisted(() => ({
  usePageMock: vi.fn(),
  useUpdatePageMock: vi.fn(),
  mutateAsyncMock: vi.fn(),
}));

vi.mock("#/api/pages", () => ({
  usePage: usePageMock,
  useUpdatePage: useUpdatePageMock,
}));

const page = {
  path: "journals/2026-08-11.md",
  canonical_name: "2026-08-11",
  body: "Journal body\n",
  revision: "rev-a",
  kind: "JOURNAL",
  inferred: false,
  project: null,
  computed_tags: ["journal"],
  meta: {
    id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62",
    title: "2026-08-11",
    tags: ["research", "temporary"],
    aliases: [],
  },
};

describe("usePageEditor computed tag state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    usePageMock.mockReturnValue({
      data: page,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
    mutateAsyncMock.mockResolvedValue({
      ...page,
      revision: "rev-b",
      meta: { ...page.meta, tags: ["research"] },
    });
    useUpdatePageMock.mockReturnValue({ mutateAsync: mutateAsyncMock });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("keeps computed tags separate and never serializes them with editable tags", async () => {
    const { result, unmount } = renderHook(() =>
      usePageEditor("journals/2026-08-11.md"),
    );

    expect(result.current.tags).toEqual(["research", "temporary"]);
    expect(result.current.computedTags).toEqual(["journal"]);

    act(() => result.current.setTags(["research"]));
    await act(async () => {
      await result.current.saveNow();
    });

    expect(mutateAsyncMock).toHaveBeenCalledOnce();
    expect(mutateAsyncMock.mock.calls[0][0].body.tags).toEqual(["research"]);
    expect(mutateAsyncMock.mock.calls[0][0].body.tags).not.toContain("journal");
    unmount();
  });
});

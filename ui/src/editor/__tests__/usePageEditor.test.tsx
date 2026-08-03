import { act, renderHook } from "@testing-library/react";
import type { Descendant, Editor } from "slate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePageEditor } from "../usePageEditor";

const { usePageMock, useUpdatePageMock, mutateMock } = vi.hoisted(() => ({
  usePageMock: vi.fn(),
  useUpdatePageMock: vi.fn(),
  mutateMock: vi.fn(),
}));

vi.mock("#/api/pages", () => ({
  usePage: usePageMock,
  useUpdatePage: useUpdatePageMock,
}));

function paragraph(text: string): Descendant[] {
  return [{ type: "paragraph", children: [{ text }] }] as Descendant[];
}

function astChangeEditor(): Editor {
  return {
    operations: [{ type: "insert_text", path: [0, 0], offset: 0, text: "x" }],
  } as unknown as Editor;
}

function makePage(body: string) {
  return {
    path: "notes/page.md",
    body: `${body}\n`,
    meta: {
      title: null,
      tags: [],
      aliases: [],
    },
  };
}

describe("usePageEditor save sequencing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("ignores stale save success after a newer no-op save attempt", () => {
    const pending: Array<{
      request: unknown;
      options: { onSuccess?: () => void };
    }> = [];

    mutateMock.mockImplementation((request, options) => {
      pending.push({
        request,
        options: (options ?? {}) as { onSuccess?: () => void },
      });
    });

    usePageMock.mockReturnValue({
      data: makePage("A"),
      isLoading: false,
      error: null,
    });
    useUpdatePageMock.mockReturnValue({ mutate: mutateMock });

    const { result } = renderHook(() => usePageEditor("notes/page.md"));

    // 1) Edit body to B and let autosave fire mutation A.
    act(() => {
      result.current.onSlateChange(paragraph("B"), astChangeEditor());
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(pending).toHaveLength(1);
    const firstRequest = pending[0].request as {
      body: Record<string, unknown>;
    };
    expect("body" in firstRequest.body).toBe(true);

    // 2) Revert body to A and force an immediate doSave; this is a no-op save
    // attempt (no mutation), but must still invalidate stale callbacks.
    act(() => {
      result.current.onSlateChange(paragraph("A"), astChangeEditor());
    });
    act(() => {
      result.current.saveNow();
    });

    expect(pending).toHaveLength(1);

    // 3) Old mutation A resolves late. It must be ignored as stale.
    act(() => {
      pending[0].options.onSuccess?.();
    });

    // 4) Metadata-only save should NOT include body. If stale A was applied,
    // body would be considered dirty and this request would wrongly include it.
    act(() => {
      result.current.setTitle("Renamed");
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(pending).toHaveLength(2);
    const secondRequest = pending[1].request as {
      body: Record<string, unknown>;
    };
    expect(secondRequest.body.title).toBe("Renamed");
    expect("body" in secondRequest.body).toBe(false);
  });
});

describe("usePageEditor debounce survival", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    usePageMock.mockReturnValue({
      data: makePage("A"),
      isLoading: false,
      error: null,
    });
    // The real useMutation returns a fresh result object on every render
    // (only .mutate is referentially stable). A stable mock here would hide
    // any code path that keys effects on the mutation object's identity.
    useUpdatePageMock.mockImplementation(() => ({ mutate: mutateMock }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("fires the debounced save for a lone edit despite status re-renders", () => {
    const { result } = renderHook(() => usePageEditor("notes/page.md"));

    act(() => {
      result.current.onSlateChange(paragraph("B"), astChangeEditor());
    });
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(mutateMock).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending save on unmount instead of dropping it", () => {
    const { result, unmount } = renderHook(() =>
      usePageEditor("notes/page.md"),
    );

    act(() => {
      result.current.onSlateChange(paragraph("B"), astChangeEditor());
    });
    unmount();

    expect(mutateMock).toHaveBeenCalledTimes(1);
  });
});

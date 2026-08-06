import { act, renderHook } from "@testing-library/react";
import type { Descendant, Editor } from "slate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePageEditor } from "../usePageEditor";

const { usePageMock, useUpdatePageMock, mutateAsyncMock, refetchPageMock } =
  vi.hoisted(() => ({
    usePageMock: vi.fn(),
    useUpdatePageMock: vi.fn(),
    mutateAsyncMock: vi.fn(),
    refetchPageMock: vi.fn(),
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

interface MockPage {
  path: string;
  canonical_name: string;
  body: string;
  revision: string;
  kind: string;
  inferred: boolean;
  project: null;
  meta: {
    id: string;
    title: string | null;
    tags: string[];
    aliases: string[];
  };
}

function makePage(body: string) {
  return {
    path: "notes/page.md",
    canonical_name: "page",
    body: `${body}\n`,
    revision: "rev-a",
    kind: "NOTE",
    inferred: true,
    project: null,
    meta: {
      id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62",
      title: null,
      tags: [],
      aliases: [],
    },
  };
}

function revisionConflict(currentRevision = "rev-b") {
  return {
    status: 409,
    error: "page changed since it was loaded",
    detail: {
      code: "revision_conflict",
      current_revision: currentRevision,
    },
    hint: null,
  };
}

describe("usePageEditor save sequencing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    usePageMock.mockReturnValue({
      data: makePage("A"),
      isLoading: false,
      error: null,
      refetch: refetchPageMock,
    });
    refetchPageMock.mockResolvedValue({ data: makePage("A") });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("serializes overlapping saves and advances the expected revision", async () => {
    const pending: Array<{
      request: { body: Record<string, unknown> };
      resolve: (page: MockPage) => void;
    }> = [];
    const mutateAsync = vi.fn(
      (request: { body: Record<string, unknown> }) =>
        new Promise<MockPage>((resolve) => {
          pending.push({ request, resolve });
        }),
    );
    useUpdatePageMock.mockReturnValue({ mutateAsync });

    const { result, unmount } = renderHook(() =>
      usePageEditor("notes/page.md"),
    );
    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    act(() => vi.advanceTimersByTime(1500));
    expect(pending).toHaveLength(1);
    expect(pending[0].request.body.expected_revision).toBe("rev-a");

    act(() => result.current.onSlateChange(paragraph("C"), astChangeEditor()));
    act(() => result.current.saveNow());
    expect(pending).toHaveLength(1);

    await act(async () => {
      pending[0].resolve({ ...makePage("B"), revision: "rev-b" });
      await Promise.resolve();
    });

    expect(pending).toHaveLength(2);
    expect(pending[1].request.body.expected_revision).toBe("rev-b");
    expect(pending[1].request.body.body).toBe("C\n");
    unmount();
  });

  it("decodes plain API conflicts without retrying automatically", async () => {
    mutateAsyncMock.mockRejectedValue(revisionConflict());
    useUpdatePageMock.mockReturnValue({ mutateAsync: mutateAsyncMock });

    const { result } = renderHook(() => usePageEditor("notes/page.md"));
    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(result.current.saveStatus).toBe("error");
    expect(result.current.saveError).toBe("page changed since it was loaded");
    expect(result.current.revisionConflict).toEqual({
      currentRevision: "rev-b",
    });

    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("keeps a conflict unresolved when local content reverts", async () => {
    mutateAsyncMock.mockRejectedValue(revisionConflict());
    useUpdatePageMock.mockReturnValue({ mutateAsync: mutateAsyncMock });

    const { result } = renderHook(() => usePageEditor("notes/page.md"));
    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => result.current.onSlateChange(paragraph("A"), astChangeEditor()));
    act(() => result.current.saveNow());

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(result.current.saveStatus).toBe("error");
    expect(result.current.revisionConflict).toEqual({
      currentRevision: "rev-b",
    });
  });

  it("reloads server content only after explicit conflict recovery", async () => {
    mutateAsyncMock.mockRejectedValue(revisionConflict());
    useUpdatePageMock.mockReturnValue({ mutateAsync: mutateAsyncMock });
    const latest = {
      ...makePage("External"),
      revision: "rev-b",
      meta: { ...makePage("External").meta, title: "External title" },
    };
    refetchPageMock.mockResolvedValue({ data: latest });

    const { result } = renderHook(() => usePageEditor("notes/page.md"));
    const editorRevision = result.current.editorRevision;
    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await act(async () => {
      vi.advanceTimersByTime(1500);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.reloadAfterConflict();
    });

    expect(refetchPageMock).toHaveBeenCalledTimes(1);
    expect(result.current.title).toBe("External title");
    expect(result.current.editorRevision).toBeGreaterThan(editorRevision);
    expect(result.current.revisionConflict).toBeNull();
    expect(result.current.saveStatus).toBe("saved");
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
      refetch: refetchPageMock,
    });
    mutateAsyncMock.mockResolvedValue(makePage("B"));
    // The real useMutation returns a fresh result object on every render
    // (only .mutateAsync is referentially stable). A stable mock here would
    // hide any code path that keys effects on the mutation object's identity.
    useUpdatePageMock.mockImplementation(() => ({
      mutateAsync: mutateAsyncMock,
    }));
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
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(1500);
    });

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending save on unmount instead of dropping it", () => {
    const { result, unmount } = renderHook(() =>
      usePageEditor("notes/page.md"),
    );

    act(() => {
      result.current.onSlateChange(paragraph("B"), astChangeEditor());
    });
    unmount();

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
  });
});

function notFoundError() {
  return { status: 404, error: "page not found", detail: null, hint: null };
}

function ensuredPage(body = "") {
  return {
    path: "journals/2026-08-06.md",
    revision: "rev-e",
    body,
    meta: { title: "2026-08-06", tags: ["journal"], aliases: [] },
  };
}

async function flushDraftSave() {
  await act(async () => {
    vi.advanceTimersByTime(1500);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("usePageEditor draft mode", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    usePageMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      error: notFoundError(),
      refetch: refetchPageMock,
    });
    useUpdatePageMock.mockImplementation(() => ({
      mutateAsync: mutateAsyncMock,
    }));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("enters draft state on 404 when ensure is provided", () => {
    const ensure = vi.fn();
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );
    expect(result.current.isDraft).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.saveStatus).toBe("saved");
    expect(ensure).not.toHaveBeenCalled();
  });

  it("still surfaces the 404 as an error without ensure", () => {
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md"),
    );
    expect(result.current.isDraft).toBe(false);
    expect(result.current.error).not.toBeNull();
  });

  it("ensures before the first update and adopts the template", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValue({ page: ensuredPage(), created: true });
    mutateAsyncMock.mockResolvedValue({ ...makePage("B"), revision: "rev-f" });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await flushDraftSave();

    expect(ensure).toHaveBeenCalledTimes(1);
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(ensure.mock.invocationCallOrder[0]).toBeLessThan(
      mutateAsyncMock.mock.invocationCallOrder[0],
    );
    const request = mutateAsyncMock.mock.calls[0][0];
    expect(request.body.expected_revision).toBe("rev-e");
    expect(request.body.body).toBe("B\n");
    // Untouched template metadata is adopted, not re-sent.
    expect(request.body.title).toBeUndefined();
    expect(result.current.title).toBe("2026-08-06");
    expect(result.current.tags).toEqual(["journal"]);
    expect(result.current.isDraft).toBe(false);
  });

  it("keeps a user-typed title through the first save", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValue({ page: ensuredPage(), created: true });
    mutateAsyncMock.mockResolvedValue({ ...makePage(""), revision: "rev-f" });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.setTitle("My day"));
    await flushDraftSave();

    const request = mutateAsyncMock.mock.calls[0][0];
    expect(request.body.title).toBe("My day");
    expect(result.current.title).toBe("My day");
  });

  it("retries ensure on the next save after a failure", async () => {
    const ensure = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ page: ensuredPage(), created: true });
    mutateAsyncMock.mockResolvedValue({ ...makePage("B"), revision: "rev-f" });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await flushDraftSave();
    expect(result.current.saveStatus).toBe("error");
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(result.current.isDraft).toBe(true);

    act(() => result.current.onSlateChange(paragraph("Bx"), astChangeEditor()));
    await flushDraftSave();
    expect(ensure).toHaveBeenCalledTimes(2);
    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
  });

  it("adopts an existing empty journal without conflict", async () => {
    const ensure = vi
      .fn()
      .mockResolvedValue({ page: ensuredPage(""), created: false });
    mutateAsyncMock.mockResolvedValue({ ...makePage("B"), revision: "rev-f" });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await flushDraftSave();

    expect(mutateAsyncMock).toHaveBeenCalledTimes(1);
    expect(result.current.revisionConflict).toBeNull();
  });

  it("raises the conflict flow when the page already has content", async () => {
    const ensure = vi.fn().mockResolvedValue({
      page: ensuredPage("Someone else\n"),
      created: false,
    });
    const { result } = renderHook(() =>
      usePageEditor("journals/2026-08-06.md", { ensure }),
    );

    act(() => result.current.onSlateChange(paragraph("B"), astChangeEditor()));
    await flushDraftSave();

    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(result.current.saveStatus).toBe("error");
    expect(result.current.revisionConflict).toEqual({
      currentRevision: "rev-e",
    });
  });
});

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoardTask, PatchTaskRequest } from "#/api/board";
import { useDebounced, usePatchQueue } from "../usePatchQueue";

type Lane = "title" | "status";

interface Call {
  id: string;
  patch: PatchTaskRequest;
  resolve: (task: BoardTask) => void;
  reject: (error: Error) => void;
}

/** A send function whose every call waits for the test to settle it. */
function deferredSend() {
  const calls: Call[] = [];
  const send = vi.fn(
    (req: { id: string; patch: PatchTaskRequest }) =>
      new Promise<BoardTask>((resolve, reject) => {
        calls.push({ ...req, resolve, reject });
      }),
  );
  return { calls, send };
}

const saved = (path: string) => ({ path }) as BoardTask;

/** Lets queued promise callbacks run. */
const settle = () => act(async () => {});

describe("usePatchQueue", () => {
  it("sends patches one at a time, in order", async () => {
    const { calls, send } = deferredSend();
    const { result } = renderHook(() =>
      usePatchQueue<Lane>({ id: "t1", path: "a.md" }, send),
    );

    result.current.patchNow("title", { title: "One" });
    result.current.patchNow("status", { status: "FIELD" });
    await settle();
    expect(calls.map((c) => c.patch)).toEqual([{ title: "One" }]);

    calls[0].resolve(saved("a.md"));
    await settle();
    expect(calls.map((c) => c.patch)).toEqual([
      { title: "One" },
      { status: "FIELD" },
    ]);
    expect(calls[1].id).toBe("t1");
  });

  it("tracks the saved path for a later archive", async () => {
    const { calls, send } = deferredSend();
    const { result } = renderHook(() =>
      usePatchQueue<Lane>({ id: "t1", path: "a.md" }, send),
    );
    expect(result.current.latestPath()).toBe("a.md");

    result.current.patchNow("title", { title: "Moved" });
    await settle();
    calls[0].resolve(saved("b.md"));
    await settle();
    expect(result.current.latestPath()).toBe("b.md");
  });

  it("the barrier waits for every patch and rejects while a lane failed", async () => {
    const { calls, send } = deferredSend();
    const { result } = renderHook(() =>
      usePatchQueue<Lane>({ id: "t1", path: "a.md" }, send),
    );

    const failed = result.current.enqueue("title", { title: "One" });
    failed.catch(() => undefined);
    await settle();
    calls[0].reject(new Error("409"));
    await expect(failed).rejects.toThrow("409");
    await expect(result.current.barrier()).rejects.toThrow(
      "One or more task edits failed to save.",
    );

    // A newer save on the same lane supersedes the failure.
    result.current.patchNow("title", { title: "Two" });
    await settle();
    calls[1].resolve(saved("a.md"));
    await expect(result.current.barrier()).resolves.toBeUndefined();
  });

  it("clearFailure drops a lane's failure, even one still in flight", async () => {
    const { calls, send } = deferredSend();
    const { result } = renderHook(() =>
      usePatchQueue<Lane>({ id: "t1", path: "a.md" }, send),
    );

    result.current.patchNow("status", { status: "FIELD" });
    await settle();
    result.current.clearFailure("status");
    calls[0].reject(new Error("400"));
    await expect(result.current.barrier()).resolves.toBeUndefined();
  });

  it("a new task identity resets the lanes and ignores the old task's failures", async () => {
    const { calls, send } = deferredSend();
    const { result, rerender } = renderHook(
      ({ id }) => usePatchQueue<Lane>({ id, path: `${id}.md` }, send),
      { initialProps: { id: "t1" } },
    );

    result.current.patchNow("title", { title: "Old" });
    await settle();
    rerender({ id: "t2" });
    expect(result.current.latestPath()).toBe("t2.md");

    calls[0].reject(new Error("409"));
    await expect(result.current.barrier()).resolves.toBeUndefined();
  });
});

describe("useDebounced", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("delivers only the latest value once the delay passes", async () => {
    const onChange = vi.fn();
    const { rerender } = renderHook(
      ({ value }) => useDebounced(value, 300, onChange),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "ab" });
    await act(() => vi.advanceTimersByTimeAsync(299));
    expect(onChange).not.toHaveBeenCalled();

    rerender({ value: "abc" });
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith("abc");
  });

  it("flush delivers a pending value at once, and awaits it", async () => {
    let finish = () => {};
    const onChange = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { result, rerender } = renderHook(
      ({ value }) => useDebounced(value, 300, onChange),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "ab" });

    let flushed = false;
    const flush = result.current().then(() => {
      flushed = true;
    });
    await act(async () => {});
    expect(onChange).toHaveBeenLastCalledWith("ab");
    expect(flushed).toBe(false);

    finish();
    await act(() => flush);
    expect(flushed).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(300));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("flushes a pending value on unmount", async () => {
    const onChange = vi.fn();
    const { rerender, unmount } = renderHook(
      ({ value }) => useDebounced(value, 300, onChange),
      { initialProps: { value: "a" } },
    );
    rerender({ value: "ab" });
    onChange.mockClear();
    unmount();
    await act(async () => {});
    expect(onChange).toHaveBeenCalledWith("ab");
  });

  it("keeps a failed value pending for the next flush", async () => {
    const onChange = vi
      .fn<(v: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { result } = renderHook(() => useDebounced("a", 300, onChange));

    await act(async () => {
      await result.current().catch(() => undefined);
    });
    await act(() => result.current());
    expect(onChange.mock.calls).toEqual([["a"], ["a"]]);
  });
});

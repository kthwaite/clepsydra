import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCopyToClipboard } from "#/hooks/useCopyToClipboard";

const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

function setClipboard(writeText: unknown) {
  Object.defineProperty(navigator, "clipboard", {
    value: writeText === undefined ? undefined : { writeText },
    configurable: true,
  });
}

describe("useCopyToClipboard", () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    toastError.mockClear();
    setClipboard(vi.fn().mockResolvedValue(undefined));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes the given text to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("const x = 1;");
    });

    expect(writeText).toHaveBeenCalledWith("const x = 1;");
  });

  it("fires a success toast after copying", async () => {
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello");
    });

    expect(toastSuccess).toHaveBeenCalledWith("Copied to clipboard");
    expect(toastError).not.toHaveBeenCalled();
  });

  it("flags copied, then resets after the timeout", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello");
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(result.current.copied).toBe(false);
  });

  it("restarts the reset timer when copied again before it expires", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useCopyToClipboard(1200));

    await act(async () => {
      await result.current.copy("a");
    });
    act(() => {
      vi.advanceTimersByTime(800);
    });

    // Second copy partway through should clear the first timer, not stack it.
    await act(async () => {
      await result.current.copy("b");
    });
    act(() => {
      vi.advanceTimersByTime(800); // 1600ms since first copy, 800ms since second
    });
    expect(result.current.copied).toBe(true);

    act(() => {
      vi.advanceTimersByTime(400); // 1200ms since the second copy
    });
    expect(result.current.copied).toBe(false);
  });

  it("fires an error toast when the clipboard write rejects", async () => {
    setClipboard(vi.fn().mockRejectedValue(new Error("denied")));
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello");
    });

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(toastError).toHaveBeenCalledWith("Couldn't copy to clipboard");
    expect(result.current.copied).toBe(false);
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("fires an error toast when the clipboard API is unavailable", async () => {
    setClipboard(undefined);
    const { result } = renderHook(() => useCopyToClipboard());

    await act(async () => {
      await result.current.copy("hello");
    });

    expect(toastError).toHaveBeenCalledWith("Couldn't copy to clipboard");
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { openTabMock, mutateAsyncMock, toastErrorMock } = vi.hoisted(() => ({
  openTabMock: vi.fn(),
  mutateAsyncMock: vi.fn(),
  toastErrorMock: vi.fn(),
}));
vi.mock("#/api/journal", () => ({
  useEnsureJournalForDate: () => ({ mutateAsync: mutateAsyncMock }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

import { useOpenJournalForDate } from "#/hooks/useOpenJournalForDate";
import { todayJournalPath } from "#/lib/journal";

const PAST_PATH = "journals/20260930.2026-09-02.abcd1234.md";

describe("useOpenJournalForDate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the existing journal path without creating", async () => {
    const { result } = renderHook(() => useOpenJournalForDate());
    await result.current("2026-09-02", PAST_PATH);
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(openTabMock).toHaveBeenCalledWith("page", PAST_PATH, "2026-09-02");
  });

  it("opens today's draft path without creating", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 30, 10, 0));
    const { result } = renderHook(() => useOpenJournalForDate());
    await result.current("2026-09-30");
    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      todayJournalPath(),
      "2026-09-30",
    );
  });

  it("creates then opens a past day's journal", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 30, 10, 0));
    mutateAsyncMock.mockResolvedValue({
      page: { path: PAST_PATH },
      created: true,
    });
    const { result } = renderHook(() => useOpenJournalForDate());
    await result.current("2026-09-02");
    expect(mutateAsyncMock).toHaveBeenCalledWith("2026-09-02");
    expect(openTabMock).toHaveBeenCalledWith("page", PAST_PATH, "2026-09-02");
  });

  it("does not open a tab when creation fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 8, 30, 10, 0));
    mutateAsyncMock.mockRejectedValue(new Error("disk full"));
    const { result } = renderHook(() => useOpenJournalForDate());
    await expect(result.current("2026-09-02")).resolves.toBeUndefined();
    expect(openTabMock).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("2026-09-02"),
      expect.objectContaining({ description: "disk full" }),
    );
  });
});

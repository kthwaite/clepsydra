import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { openTabMock, journalTodayMock } = vi.hoisted(() => ({
  openTabMock: vi.fn(),
  journalTodayMock: vi.fn(),
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: journalTodayMock,
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { todayJournalPath } from "#/lib/journal";

const CANONICAL_TODAY_PATH = "journals/20260808T005500Z--2026-08-08--a1b2c3.md";

describe("useOpenTodayJournal", () => {
  it("opens the canonical page when today's journal already exists", () => {
    journalTodayMock.mockReturnValue({
      data: {
        path: CANONICAL_TODAY_PATH,
        meta: { title: "2026-08-08" },
      },
      refetch: vi.fn(),
    });
    const { result } = renderHook(() => useOpenTodayJournal());
    result.current();
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      CANONICAL_TODAY_PATH,
      "2026-08-08",
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    journalTodayMock.mockReturnValue({ data: null, refetch: vi.fn() });
  });
  it("opens today's journal as a page tab labelled with the date key", () => {
    const { result } = renderHook(() => useOpenTodayJournal());
    result.current();
    const path = todayJournalPath();
    const dateKey = path.slice("journals/".length, -".md".length);
    expect(openTabMock).toHaveBeenCalledWith("page", path, dateKey);
  });
});

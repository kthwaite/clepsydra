import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { openTabMock } = vi.hoisted(() => ({ openTabMock: vi.fn() }));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { useOpenTodayJournal } from "#/hooks/useOpenTodayJournal";
import { todayJournalPath } from "#/lib/journal";

describe("useOpenTodayJournal", () => {
  it("opens today's journal as a page tab labelled with the date key", () => {
    const { result } = renderHook(() => useOpenTodayJournal());
    result.current();
    const path = todayJournalPath();
    const dateKey = path.slice("journals/".length, -".md".length);
    expect(openTabMock).toHaveBeenCalledWith("page", path, dateKey);
  });
});

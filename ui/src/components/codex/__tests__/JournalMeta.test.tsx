import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { useJournalRecentMock, updateTabPathMock } = vi.hoisted(() => ({
  useJournalRecentMock: vi.fn(),
  updateTabPathMock: vi.fn(),
}));
vi.mock("#/api/journal", () => ({
  useJournalRecent: useJournalRecentMock,
}));
vi.mock("#/store/workspace", () => ({
  useWorkspaceStore: (sel: (s: unknown) => unknown) =>
    sel({ updateTabPath: updateTabPathMock }),
}));

import { JournalMeta } from "../JournalMeta";

const entry = (d: string) => ({
  id: d,
  path: `journals/${d}.md`,
  title: d,
  journal_date: d,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-07T12:00:00"));
  updateTabPathMock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("JournalMeta", () => {
  it("prev skips gap days to the nearest written entry", () => {
    useJournalRecentMock.mockReturnValue({
      data: [entry("2026-08-07"), entry("2026-08-04")],
    });
    render(
      <JournalMeta path="journals/2026-08-07.md" tabId="t1" isDraft={false} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "previous entry" }));
    expect(updateTabPathMock).toHaveBeenCalledWith(
      "t1",
      "journals/2026-08-04.md",
      "2026-08-04",
    );
  });

  it("disables prev at the window edge and next on today", () => {
    useJournalRecentMock.mockReturnValue({ data: [entry("2026-08-07")] });
    render(
      <JournalMeta path="journals/2026-08-07.md" tabId="t1" isDraft={false} />,
    );
    expect(
      screen.getByRole("button", { name: "previous entry" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "next entry" })).toBeDisabled();
  });

  it("renders skipped days as non-interactive rows", () => {
    useJournalRecentMock.mockReturnValue({
      data: [entry("2026-08-07"), entry("2026-08-05")],
    });
    render(
      <JournalMeta path="journals/2026-08-07.md" tabId="t1" isDraft={false} />,
    );
    const skipped = screen.getByRole("button", { name: /6\/8/ });
    expect(skipped).toBeDisabled();
    const written = screen.getByRole("button", { name: /5\/8/ });
    fireEvent.click(written);
    expect(updateTabPathMock).toHaveBeenCalledWith(
      "t1",
      "journals/2026-08-05.md",
      "2026-08-05",
    );
  });

  it("shows unwritten state for a draft and day-of-year marginalia", () => {
    useJournalRecentMock.mockReturnValue({ data: [] });
    render(
      <JournalMeta path="journals/2026-08-07.md" tabId="t1" isDraft={true} />,
    );
    expect(screen.getByText("unwritten")).toBeInTheDocument();
    expect(screen.getByText("219 / 365")).toBeInTheDocument();
  });
});

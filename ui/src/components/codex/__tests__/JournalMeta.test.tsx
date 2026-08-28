import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  useJournalRecentMock,
  useAiJournalRecentMock,
  updateTabPathMock,
  openTabMock,
} = vi.hoisted(() => ({
  useJournalRecentMock: vi.fn(),
  useAiJournalRecentMock: vi.fn(),
  updateTabPathMock: vi.fn(),
  openTabMock: vi.fn(),
}));
vi.mock("#/api/journal", () => ({
  useJournalRecent: useJournalRecentMock,
}));
vi.mock("#/api/aiJournal", () => ({
  useAiJournalRecent: useAiJournalRecentMock,
}));
vi.mock("#/store/workspace", () => ({
  useWorkspaceStore: (sel: (s: unknown) => unknown) =>
    sel({ updateTabPath: updateTabPathMock }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

import { AiJournalMeta, JournalMeta } from "../JournalMeta";

// The rail props carry the page tags; the journal blocks ignore them.
const noop = () => {};

const entry = (d: string) => ({
  id: d,
  path: `journals/${d}.md`,
  title: d,
  journal_date: d,
});

const aiEntry = (d: string) => ({
  id: d,
  path: `ai-journals/${d}.md`,
  title: d,
  journal_date: d,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-07T12:00:00"));
  updateTabPathMock.mockClear();
  openTabMock.mockClear();
  // Default: no cross-link data unless a test overrides it.
  useAiJournalRecentMock.mockReturnValue({ data: [] });
  useJournalRecentMock.mockReturnValue({ data: [] });
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
      <JournalMeta
        path="journals/2026-08-07.md"
        tabId="t1"
        isDraft={false}
        tags={[]}
        onTagsChange={noop}
      />,
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
      <JournalMeta
        path="journals/2026-08-07.md"
        tabId="t1"
        isDraft={false}
        tags={[]}
        onTagsChange={noop}
      />,
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
      <JournalMeta
        path="journals/2026-08-07.md"
        tabId="t1"
        isDraft={false}
        tags={[]}
        onTagsChange={noop}
      />,
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
      <JournalMeta
        path="journals/2026-08-07.md"
        tabId="t1"
        isDraft={true}
        tags={[]}
        onTagsChange={noop}
      />,
    );
    // Scoped to the State row: today's cross-link row can also read
    // "unwritten" when the AI counterpart has no entry yet.
    expect(screen.getByText("State").nextElementSibling).toHaveTextContent(
      "unwritten",
    );
    expect(screen.getByText("219 / 365")).toBeInTheDocument();
  });

  it("shows an 'AI journal' cross-link row that opens the written counterpart", () => {
    useJournalRecentMock.mockReturnValue({ data: [entry("2026-08-07")] });
    useAiJournalRecentMock.mockReturnValue({
      data: [aiEntry("2026-08-07")],
    });
    render(
      <JournalMeta
        path="journals/2026-08-07.md"
        tabId="t1"
        isDraft={false}
        tags={[]}
        onTagsChange={noop}
      />,
    );
    expect(screen.getByText("AI journal")).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /written/ });
    expect(row).not.toBeDisabled();
    fireEvent.click(row);
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "ai-journals/2026-08-07.md",
      "2026-08-07",
    );
  });

  it("disables the cross-link row for an unwritten non-today date", () => {
    useJournalRecentMock.mockReturnValue({ data: [entry("2026-08-04")] });
    useAiJournalRecentMock.mockReturnValue({ data: [] });
    render(
      <JournalMeta
        path="journals/2026-08-04.md"
        tabId="t1"
        isDraft={false}
        tags={[]}
        onTagsChange={noop}
      />,
    );
    const row = screen.getByRole("button", { name: /unwritten/ });
    expect(row).toBeDisabled();
  });

  it("enables the cross-link row for an unwritten TODAY and opens the draft path", () => {
    useJournalRecentMock.mockReturnValue({ data: [] });
    useAiJournalRecentMock.mockReturnValue({ data: [] });
    render(
      <JournalMeta
        path="journals/2026-08-07.md"
        tabId="t1"
        isDraft={true}
        tags={[]}
        onTagsChange={noop}
      />,
    );
    const row = screen.getByRole("button", { name: /unwritten/ });
    expect(row).not.toBeDisabled();
    fireEvent.click(row);
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "ai-journals/2026-08-07.md",
      "2026-08-07",
    );
  });
});

describe("AiJournalMeta", () => {
  it("renders the AI rail with day-nav + FASTI structure", () => {
    useAiJournalRecentMock.mockReturnValue({
      data: [aiEntry("2026-08-07"), aiEntry("2026-08-04")],
    });
    render(
      <AiJournalMeta
        path="ai-journals/2026-08-07.md"
        tabId="t1"
        isDraft={false}
        tags={[]}
        onTagsChange={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "previous entry" }));
    expect(updateTabPathMock).toHaveBeenCalledWith(
      "t1",
      "ai-journals/2026-08-04.md",
      "2026-08-04",
    );
    expect(screen.getByText("219 / 365")).toBeInTheDocument();
  });

  it("day nav prefers the real indexed path over the draft shape", () => {
    useAiJournalRecentMock.mockReturnValue({
      data: [
        {
          id: "1",
          path: "ai-journals/20260807.2026-08-07.Ab12Cd34.md",
          title: "2026-08-07",
          journal_date: "2026-08-07",
        },
        {
          id: "2",
          path: "ai-journals/20260806.2026-08-06.Ab12Cd34.md",
          title: "2026-08-06",
          journal_date: "2026-08-06",
        },
      ],
    });
    render(
      <AiJournalMeta
        path="ai-journals/20260807.2026-08-07.Ab12Cd34.md"
        tabId="t1"
        isDraft={false}
        tags={[]}
        onTagsChange={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "previous entry" }));
    expect(updateTabPathMock).toHaveBeenCalledWith(
      "t1",
      "ai-journals/20260806.2026-08-06.Ab12Cd34.md",
      "2026-08-06",
    );
  });

  it("shows the mirror 'Journal' cross-link row", () => {
    useAiJournalRecentMock.mockReturnValue({
      data: [aiEntry("2026-08-07")],
    });
    useJournalRecentMock.mockReturnValue({
      data: [entry("2026-08-07")],
    });
    render(
      <AiJournalMeta
        path="ai-journals/2026-08-07.md"
        tabId="t1"
        isDraft={false}
        tags={[]}
        onTagsChange={noop}
      />,
    );
    expect(screen.getByText("Journal")).toBeInTheDocument();
    const row = screen.getByRole("button", { name: /written/ });
    expect(row).not.toBeDisabled();
    fireEvent.click(row);
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "journals/2026-08-07.md",
      "2026-08-07",
    );
  });
});

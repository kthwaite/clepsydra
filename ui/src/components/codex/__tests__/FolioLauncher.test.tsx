import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.hoisted so the mock factory can reference openTabMock without tripping
// Vitest's hoist-above-imports rule (matches the usePageEditor test pattern).
const { openTabMock } = vi.hoisted(() => ({ openTabMock: vi.fn() }));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));
vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: null, refetch: vi.fn() }),
}));
vi.mock("#/api/aiJournal", () => ({
  useAiJournalToday: () => ({ data: null, refetch: vi.fn() }),
}));

import { todayJournalPath } from "#/lib/journal";
import { useUiStore } from "#/store/ui";
import { useWorkspaceStore } from "#/store/workspace";
import { FolioLauncher } from "../FolioLauncher";

describe("FolioLauncher", () => {
  beforeEach(() => {
    openTabMock.mockClear();
    useWorkspaceStore.setState({ openHistory: [] });
    useUiStore.setState({ isSearchOpen: false, isInscribeOpen: false });
  });

  it("shows the empty note when there is no history", () => {
    render(<FolioLauncher />);
    expect(screen.getByText("No recent folios.")).toBeInTheDocument();
  });

  it("opens the console via the quick action", async () => {
    const user = userEvent.setup();
    render(<FolioLauncher />);
    await user.click(screen.getByRole("button", { name: /open console/i }));
    expect(useUiStore.getState().isSearchOpen).toBe(true);
  });

  it("opens the inscribe modal via the quick action", async () => {
    const user = userEvent.setup();
    render(<FolioLauncher />);
    await user.click(
      screen.getByRole("button", { name: /inscribe new folio/i }),
    );
    expect(useUiStore.getState().isInscribeOpen).toBe(true);
  });

  it("opens the graph via the quick action", async () => {
    const user = userEvent.setup();
    render(<FolioLauncher />);
    await user.click(
      screen.getByRole("button", { name: /open constellation/i }),
    );
    expect(openTabMock).toHaveBeenCalledWith("graph");
  });

  it("opens today's journal from the launcher", async () => {
    const user = userEvent.setup();
    render(<FolioLauncher />);
    await user.click(screen.getByText("Today's journal"));
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      todayJournalPath(),
      expect.any(String),
    );
  });

  it("renders an AI journal action", () => {
    render(<FolioLauncher />);
    expect(
      screen.getByRole("button", { name: /ai journal/i }),
    ).toBeInTheDocument();
  });

  it("opens a recent folio when its row is clicked", async () => {
    const user = userEvent.setup();
    useWorkspaceStore.setState({
      openHistory: [
        { path: "notes/20260101.my-note.ab12CD34.md", openedAt: 1 },
      ],
    });
    render(<FolioLauncher />);
    await user.click(screen.getByText("my note"));
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/20260101.my-note.ab12CD34.md",
      "my note",
    );
  });
});

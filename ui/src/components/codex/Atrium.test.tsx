import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const atriumMocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openSearch: vi.fn(),
  openInscribe: vi.fn(),
  openLocation: vi.fn(),
  openTab: vi.fn(),
  openTodayJournal: vi.fn(),
  workspaceState: {
    openHistory: [] as Array<{ path: string; openedAt: number }>,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => atriumMocks.navigate,
}));

vi.mock("#/api/bcl", () => ({
  useBcl: () => ({ data: undefined }),
}));

vi.mock("#/api/index", () => ({
  useTags: () => ({ data: [] }),
  useStats: () => ({ data: undefined }),
  useContentIndex: () => ({ data: { items: [] } }),
  useReferenceIssues: () => ({
    data: { items: [], total: 0, limit: 1, offset: 0 },
  }),
}));

vi.mock("#/api/journal", () => ({
  useJournalToday: () => ({ data: undefined }),
}));

vi.mock("#/api/location", () => ({
  useLocation: () => ({ data: undefined }),
}));

vi.mock("#/hooks/useClock", () => ({
  useClock: () => new Date(2026, 7, 9, 12),
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => atriumMocks.openTab,
}));

vi.mock("#/hooks/useOpenTodayJournal", () => ({
  useOpenTodayJournal: () => atriumMocks.openTodayJournal,
}));

vi.mock("#/store/ui", () => ({
  useUiStore: (
    selector: (state: {
      openSearch: typeof atriumMocks.openSearch;
      openInscribe: typeof atriumMocks.openInscribe;
      openLocation: typeof atriumMocks.openLocation;
    }) => unknown,
  ) =>
    selector({
      openSearch: atriumMocks.openSearch,
      openInscribe: atriumMocks.openInscribe,
      openLocation: atriumMocks.openLocation,
    }),
}));

vi.mock("#/store/workspace", () => ({
  useWorkspaceStore: (
    selector: (state: typeof atriumMocks.workspaceState) => unknown,
  ) => selector(atriumMocks.workspaceState),
}));

vi.mock("#/components/codex/ActivityHeatmap", () => ({
  ActivityHeatmap: () => <div data-testid="activity-heatmap" />,
}));

vi.mock("#/components/codex/FeedRiverPanel", () => ({
  FeedRiverPanel: () => (
    <section aria-label="Feed river panel" data-testid="feed-river-panel" />
  ),
}));

vi.mock("#/components/codex/ReadingContinues", () => ({
  ReadingContinuesPanel: () => null,
}));

vi.mock("#/components/codex/SkyCard", () => ({
  SkyCard: () => <section aria-label="Sky" />,
}));

import { Atrium } from "#/components/codex/Atrium";

function closestSection(element: HTMLElement): HTMLElement {
  const section = element.closest("section");
  if (!section) throw new Error("Expected content inside a section");
  return section;
}

describe("Atrium feed river placement", () => {
  it("keeps the feed panel after Activity and before Recents without Stats cards", () => {
    render(<Atrium />);

    const activity = closestSection(
      screen.getByText("Activity · Rolling 26 weeks"),
    );
    const panel = screen.getByRole("region", { name: "Feed river panel" });
    const recents = closestSection(screen.getByText("FIG. VI"));

    expect(
      activity.compareDocumentPosition(panel) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      panel.compareDocumentPosition(recents) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.queryByText("Vessel · Inventory")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Subjects, by frequency"),
    ).not.toBeInTheDocument();
  });

  it("does not render the retired aphorism card or quotation", () => {
    render(<Atrium />);

    expect(screen.queryByText("Aphorism")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/The notebook is a net for catching days\./),
    ).not.toBeInTheDocument();
  });
});

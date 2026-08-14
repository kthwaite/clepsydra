import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

interface BclFixture {
  birth_date: string;
  bcl_date: string;
  remaining_seconds: number;
}

const atriumMocks = vi.hoisted(() => ({
  bcl: undefined as BclFixture | undefined,
  navigate: vi.fn(),
  openSearch: vi.fn(),
  openInscribe: vi.fn(),
  openLocation: vi.fn(),
  openTab: vi.fn(),
  openTodayJournal: vi.fn(),
  readingContinues: false,
  workspaceState: {
    openHistory: [] as Array<{ path: string; openedAt: number }>,
  },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => atriumMocks.navigate,
}));

vi.mock("#/api/bcl", () => ({
  useBcl: () => ({ data: atriumMocks.bcl }),
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

vi.mock("#/components/codex/AgendaTile", () => ({
  AgendaTile: ({ className }: { className?: string }) => (
    <section aria-label="Outstanding agenda" className={className} />
  ),
}));

vi.mock("#/components/codex/FeedRiverPanel", () => ({
  FeedRiverPanel: () => (
    <section
      aria-label="Feed river panel"
      className="col-span-12"
      data-testid="feed-river-panel"
    />
  ),
}));

vi.mock("#/components/codex/ReadingContinues", () => ({
  ReadingContinuesPanel: () =>
    atriumMocks.readingContinues ? (
      <section aria-label="Reading Continues" className="col-span-12" />
    ) : null,
}));

vi.mock("#/components/codex/SkyCard", () => ({
  SkyCard: ({ className }: { className?: string }) => (
    <section aria-label="Sky" className={className} />
  ),
}));

import { Atrium } from "#/components/codex/Atrium";

function closestSection(element: HTMLElement): HTMLElement {
  const section = element.closest("section");
  if (!section) throw new Error("Expected content inside a section");
  return section;
}

function expectBefore(first: HTMLElement, second: HTMLElement) {
  expect(
    first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

beforeEach(() => {
  vi.clearAllMocks();
  atriumMocks.bcl = undefined;
  atriumMocks.readingContinues = false;
});

describe("Atrium composition", () => {
  it("uses the approved single-column DOM order and desktop spans", () => {
    atriumMocks.bcl = {
      birth_date: "1980-01-01",
      bcl_date: "2050-01-01",
      remaining_seconds: 86_400,
    };
    atriumMocks.readingContinues = true;

    render(<Atrium />);

    const daystart = closestSection(screen.getByText(/DAYSTART \//));
    const recents = closestSection(screen.getByText("FIG. VI"));
    const agenda = screen.getByRole("region", { name: "Outstanding agenda" });
    const feed = screen.getByRole("region", { name: "Feed river panel" });
    const bcl = closestSection(screen.getByText("Brimley-Cocoon Line"));
    const sky = screen.getByRole("region", { name: "Sky" });
    const activity = closestSection(
      screen.getByText("Activity · Rolling 26 weeks"),
    );
    const reading = screen.getByRole("region", {
      name: "Reading Continues",
    });

    expectBefore(daystart, recents);
    expectBefore(recents, agenda);
    expectBefore(agenda, feed);
    expectBefore(feed, bcl);
    expectBefore(bcl, sky);
    expectBefore(sky, activity);
    expectBefore(activity, reading);

    expect(daystart).toHaveClass("col-span-12");
    expect(recents).toHaveClass("col-span-12", "lg:col-span-7");
    expect(agenda).toHaveClass("col-span-12", "lg:col-span-5");
    expect(feed).toHaveClass("col-span-12");
    expect(bcl).toHaveClass("col-span-12", "lg:col-span-7");
    expect(sky).toHaveClass("col-span-12", "lg:col-span-5");
    expect(activity).toHaveClass("col-span-12");
    expect(activity).not.toHaveClass("lg:col-span-8");
    expect(reading).toHaveClass("col-span-12");

    expect(recents.parentElement).toBe(agenda.parentElement);
    expect(bcl.parentElement).toBe(sky.parentElement);
    expect(bcl.parentElement).toHaveClass(
      "col-span-12",
      "grid",
      "grid-cols-12",
    );
  });

  it("expands Sky across the row when BCL is not configured", () => {
    render(<Atrium />);

    const feed = screen.getByRole("region", { name: "Feed river panel" });
    const sky = screen.getByRole("region", { name: "Sky" });
    const activity = closestSection(
      screen.getByText("Activity · Rolling 26 weeks"),
    );

    expect(
      screen.queryByText("Brimley-Cocoon Line"),
    ).not.toBeInTheDocument();
    expect(sky).toHaveClass("col-span-12", "lg:col-span-12");
    expect(sky).not.toHaveClass("lg:col-span-5");
    expectBefore(feed, sky);
    expectBefore(sky, activity);
  });

  it("keeps Reading Continues conditional", () => {
    const { rerender } = render(<Atrium />);

    expect(
      screen.queryByRole("region", { name: "Reading Continues" }),
    ).not.toBeInTheDocument();

    atriumMocks.readingContinues = true;
    rerender(<Atrium />);

    const activity = closestSection(
      screen.getByText("Activity · Rolling 26 weeks"),
    );
    const reading = screen.getByRole("region", {
      name: "Reading Continues",
    });
    expectBefore(activity, reading);
  });

  it("offers Stats from Activity", async () => {
    const user = userEvent.setup();
    render(<Atrium />);

    await user.click(screen.getByRole("button", { name: /Stats/i }));

    expect(atriumMocks.navigate).toHaveBeenCalledWith({ to: "/stats" });
  });

  it("keeps daystart compact and action-oriented without Julian time", async () => {
    const user = userEvent.setup();
    render(<Atrium />);

    const daystart = closestSection(screen.getByText(/DAYSTART \//));
    expect(daystart).toHaveTextContent("2026.08.09 (SUN)");
    expect(daystart).toHaveTextContent("WEEK 32");
    expect(daystart).toHaveTextContent("DAY 221 / 365");
    expect(daystart).toHaveTextContent("12:00 LOCAL");
    expect(daystart).not.toHaveTextContent(/\bJD\s/);

    const journal = within(daystart).getByRole("button", {
      name: /Open today’s journal/i,
    });
    const capture = within(daystart).getByRole("button", {
      name: /^Capture/i,
    });
    const search = within(daystart).getByRole("button", {
      name: /^Search/i,
    });

    await user.click(journal);
    await user.click(capture);
    await user.click(search);

    expect(atriumMocks.openTodayJournal).toHaveBeenCalledOnce();
    expect(atriumMocks.openInscribe).toHaveBeenCalledOnce();
    expect(atriumMocks.openSearch).toHaveBeenCalledOnce();
  });

  it("does not restore removed cards", () => {
    render(<Atrium />);

    expect(screen.queryByText("Vessel · Inventory")).not.toBeInTheDocument();
    expect(
      screen.queryByText("Subjects, by frequency"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Aphorism")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/The notebook is a net for catching days\./),
    ).not.toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { flags, navigateMock, unread } = vi.hoisted(() => ({
  flags: { academic: true, feeds: true },
  navigateMock: vi.fn(),
  unread: { n: 3 },
}));

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));
vi.mock("#/components/FeatureFlagsProvider", () => ({
  useFeatureFlags: () => flags,
}));
vi.mock("#/api/feeds", () => ({
  useFeeds: () => ({ data: { counts: { unread: unread.n } } }),
}));
vi.mock("#/api/index", () => ({
  useSyncConflicts: () => ({ data: { total: 0 } }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/hooks/useFolioHistoryNavigation", () => ({
  useActivateTabWithFolioHistory: () => vi.fn(),
  useLeaveFolioWorkspace: () => (proceed: () => void) => proceed(),
}));

import { MobileGoTo } from "#/components/codex/MobileGoTo";

describe("MobileGoTo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.academic = true;
    flags.feeds = true;
    unread.n = 3;
  });

  it("offers a chip per other screen plus Contents", () => {
    render(<MobileGoTo onGo={() => {}} />);
    expect(screen.getByRole("heading", { name: "Go to" })).toBeVisible();
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Gazetteer",
      "Bases",
      "Feeds · 3",
      "Academic",
      "Constellation",
      "Rubbish",
      "Contents…",
    ]);
  });

  it("drops the unread count when there is none", () => {
    unread.n = 0;
    render(<MobileGoTo onGo={() => {}} />);
    expect(screen.getByRole("button", { name: "Feeds" })).toBeVisible();
  });

  it("hides screens whose feature is off", () => {
    flags.academic = false;
    flags.feeds = false;
    render(<MobileGoTo onGo={() => {}} />);
    expect(
      screen.queryByRole("button", { name: /Academic|Feeds/ }),
    ).not.toBeInTheDocument();
  });

  it("goes to a screen and reports it", async () => {
    const onGo = vi.fn();
    render(<MobileGoTo onGo={onGo} />);
    await userEvent.click(screen.getByRole("button", { name: "Gazetteer" }));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/gazetteer" });
    expect(onGo).toHaveBeenCalledOnce();
  });

  it("expands Contents into every screen, grouped", async () => {
    const onGo = vi.fn();
    render(<MobileGoTo onGo={onGo} />);
    const contents = screen.getByRole("button", { name: "Contents…" });
    expect(contents).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(contents);
    expect(contents).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("heading", { name: "Maintain" })).toBeVisible();
    const stats = screen.getByRole("button", { name: /Stats/ });
    expect(stats).toHaveTextContent("Activity over time.");
    await userEvent.click(stats);
    expect(navigateMock).toHaveBeenCalledWith({ to: "/stats" });
    expect(onGo).toHaveBeenCalledOnce();
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(async () => {
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
});

const { flags, useFeedsMock, useConflictsMock } = vi.hoisted(() => ({
  flags: { academic: true, feeds: true },
  useFeedsMock: vi.fn(() => ({ data: { counts: { unread: 14 } } })),
  useConflictsMock: vi.fn(() => ({ data: { total: 2, items: [] } })),
}));

vi.mock("#/components/FeatureFlagsProvider", () => ({
  useFeatureFlags: () => flags,
}));
vi.mock("#/api/feeds", () => ({ useFeeds: useFeedsMock }));
vi.mock("#/api/index", () => ({ useSyncConflicts: useConflictsMock }));

import { ContentsMenu } from "#/components/codex/ContentsMenu";
import type { CodexView } from "#/components/codex/useCodexView";
import { formatChord, SHORTCUTS } from "#/lib/shortcuts";
import { useUiStore } from "#/store/ui";
import { useViewHistory } from "#/store/viewHistory";

function Harness({
  view = "atrium",
  onGo = vi.fn(),
}: {
  view?: CodexView;
  onGo?: (v: CodexView) => void;
}) {
  const ref = useRef<HTMLElement>(null);
  return (
    <header ref={ref}>
      <ContentsMenu view={view} onGo={onGo} anchorRef={ref} />
    </header>
  );
}

beforeEach(() => {
  flags.academic = true;
  flags.feeds = true;
  useFeedsMock.mockClear();
  useUiStore.setState({ isContentsOpen: false });
  useViewHistory.setState({ recent: [] });
});

async function open() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Contents" }));
  return {
    user,
    sheet: await screen.findByRole("dialog", { name: "Contents" }),
  };
}

describe("ContentsMenu", () => {
  it("groups screens from the registry in five labelled sections", async () => {
    render(<Harness />);
    const { sheet } = await open();
    for (const g of ["Write", "Organise", "Gather", "Maintain", "Reference"]) {
      expect(within(sheet).getByRole("group", { name: g })).toBeVisible();
    }
    const organise = within(sheet).getByRole("group", { name: "Organise" });
    expect(
      within(organise)
        .getAllByRole("option")
        .map((o) => o.dataset.view),
    ).toEqual(["constellation", "gazetteer", "tasking", "bases"]);
  });

  it("marks the core three", async () => {
    render(<Harness />);
    const { sheet } = await open();
    const folio = within(sheet).getByRole("option", { name: /Folio/ });
    expect(within(folio).getByText("core")).toBeVisible();
    const bases = within(sheet).getByRole("option", { name: /Bases/ });
    expect(within(bases).queryByText("core")).toBeNull();
  });

  it("shows the unread and conflict badges", async () => {
    render(<Harness />);
    const { sheet } = await open();
    expect(
      within(within(sheet).getByRole("option", { name: /Feeds/ })).getByText(
        "14",
      ),
    ).toBeVisible();
    expect(
      within(
        within(sheet).getByRole("option", { name: /Conflicts/ }),
      ).getByText("2"),
    ).toBeVisible();
  });

  it("omits Feeds, and never asks for feed counts, when Feeds is off", async () => {
    flags.feeds = false;
    render(<Harness />);
    const { sheet } = await open();
    expect(within(sheet).queryByRole("option", { name: /Feeds/ })).toBeNull();
    expect(useFeedsMock).not.toHaveBeenCalled();
  });

  it("filters by name and goes with the keyboard", async () => {
    const onGo = vi.fn();
    render(<Harness onGo={onGo} />);
    const { user, sheet } = await open();
    await user.keyboard("bases");
    expect(within(sheet).getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onGo).toHaveBeenCalledWith("bases");
    expect(useUiStore.getState().isContentsOpen).toBe(false);
  });

  it("goes on click and closes", async () => {
    const onGo = vi.fn();
    render(<Harness onGo={onGo} />);
    const { user, sheet } = await open();
    await user.click(within(sheet).getByRole("option", { name: /Stats/ }));
    expect(onGo).toHaveBeenCalledWith("stats");
    expect(screen.queryByRole("dialog", { name: "Contents" })).toBeNull();
  });

  it("closes on Escape", async () => {
    render(<Harness />);
    const { user } = await open();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Contents" })).toBeNull();
  });

  it("lists recent screens that are still enabled", async () => {
    useViewHistory.setState({ recent: ["feeds", "bases"] });
    flags.feeds = false;
    render(<Harness />);
    const { sheet } = await open();
    const recent = within(sheet).getByRole("navigation", { name: "Recently" });
    expect(
      within(recent)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Bases"]);
  });

  it("takes the active dot on a non-core screen only", () => {
    const { rerender } = render(<Harness view="bases" />);
    expect(screen.getByRole("button", { name: "Contents" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    rerender(<Harness view="folio" />);
    expect(
      screen.getByRole("button", { name: "Contents" }),
    ).not.toHaveAttribute("aria-current");
    rerender(<Harness view="atrium" />);
    expect(
      screen.getByRole("button", { name: "Contents" }),
    ).not.toHaveAttribute("aria-current");
  });

  it("shows registered shortcut hints", async () => {
    render(<Harness />);
    const { sheet } = await open();
    const gaz = within(sheet).getByRole("option", { name: /Gazetteer/ });
    expect(
      within(gaz).getByText(formatChord(SHORTCUTS["nav.gazetteer"].chord)),
    ).toBeVisible();
  });

  it("shows a focus ring when reached by keyboard", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.tab();
    const trigger = screen.getByRole("button", { name: "Contents" });
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("data-focus-visible");
    expect(trigger.className).toMatch(/data-\[focus-visible\]:ring-2/);
  });
});

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { HeatmapDay, HeatmapPage } from "./atrium-data";
import { ActivityHeatmap } from "./ActivityHeatmap";

function page(index: number, title: string | null = `Page ${index}`): HeatmapPage {
  return {
    path: title === null ? "untitled.md" : `page-${index}.md`,
    title,
    activityAt: `2026-05-02T0${index}:00:00Z`,
  };
}

function day(
  date: string,
  overrides: Partial<HeatmapDay> = {},
): HeatmapDay {
  return {
    date,
    isFuture: false,
    count: 0,
    level: 0,
    pages: [],
    ...overrides,
  };
}

const fixtureProps = {
  weeks: [
    [
      day("2026-04-27"),
      day("2026-04-28"),
      day("2026-04-29"),
      day("2026-04-30"),
      day("2026-05-01"),
      day("2026-05-02", {
        count: 6,
        level: 3,
        pages: [page(1), page(2), page(3), page(4), page(5, null), page(6)],
      }),
      day("2026-05-03"),
    ],
    [
      day("2026-05-04", { isFuture: true }),
      day("2026-05-05"),
      day("2026-05-06"),
      day("2026-05-07"),
      day("2026-05-08"),
      day("2026-05-09"),
      day("2026-05-10"),
    ],
  ],
  monthLabels: ["APR", "MAY"],
  total: 1_234,
  longest: 9,
  current: 2,
};

describe("ActivityHeatmap", () => {
  it("opens the dated page list on hover and activates a page", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={onOpenPage} />);

    await user.hover(
      screen.getByRole("button", { name: /2 May 2026, 6 captures/i }),
    );
    expect(
      await screen.findByRole("dialog", { name: /2 May 2026 activity/i }),
    ).toBeVisible();
    expect(screen.getAllByRole("button", { name: /^Open / })).toHaveLength(5);
    expect(screen.getByText("+1 more")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open Page 1" }));
    expect(onOpenPage).toHaveBeenCalledWith("page-1.md", "Page 1");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("opens on keyboard focus and exposes empty days", async () => {
    const user = userEvent.setup();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    const emptyDay = screen.getByRole("button", {
      name: /1 May 2026, 0 captures/i,
    });
    act(() => emptyDay.focus());
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveFocus();
    expect(dialog).toHaveClass("focus-visible:outline-2");
    expect(screen.getByText("0 captures")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Open / }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("stays closed after Escape restores focus to the day button", async () => {
    const user = userEvent.setup();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    const activeDay = screen.getByRole("button", {
      name: /2 May 2026, 6 captures/i,
    });
    act(() => activeDay.focus());
    expect(await screen.findByRole("dialog")).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    act(() => {
      activeDay.blur();
      activeDay.focus();
    });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(activeDay).toHaveFocus();
  });

  it("keeps the popover open while the pointer moves into it", async () => {
    const user = userEvent.setup();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    const activeDay = screen.getByRole("button", {
      name: /2 May 2026, 6 captures/i,
    });
    await user.hover(activeDay);
    const dialog = await screen.findByRole("dialog");
    await user.unhover(activeDay);
    await user.hover(dialog);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    expect(dialog).toBeVisible();
  });

  it("stays open when focus remains inside after the pointer leaves", async () => {
    const user = userEvent.setup();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    const activeDay = screen.getByRole("button", {
      name: /2 May 2026, 6 captures/i,
    });
    await user.hover(activeDay);
    const dialog = await screen.findByRole("dialog");
    await user.unhover(activeDay);
    await user.hover(dialog);
    act(() =>
      screen.getByRole("button", { name: "Open Page 2" }).focus(),
    );
    await user.unhover(dialog);

    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    expect(dialog).toBeVisible();
  });

  it("exposes native dialog disclosure state on day buttons", async () => {
    const user = userEvent.setup();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    const emptyDay = screen.getByRole("button", {
      name: /1 May 2026, 0 captures/i,
    });
    const activeDay = screen.getByRole("button", {
      name: /2 May 2026, 6 captures/i,
    });
    expect(activeDay).toHaveAttribute("aria-haspopup", "dialog");
    expect(activeDay).toHaveAttribute("aria-expanded", "false");
    expect(activeDay).not.toHaveAttribute("aria-controls");

    await user.hover(activeDay);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.id).not.toBe("");
    expect(activeDay).toHaveAttribute("aria-expanded", "true");
    expect(activeDay).toHaveAttribute("aria-controls", dialog.id);
    expect(emptyDay).toHaveAttribute("aria-expanded", "false");
    expect(emptyDay).not.toHaveAttribute("aria-controls");
  });

  it("opens on click, dismisses outside, and falls back to a page path", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={onOpenPage} />);

    const activeDay = screen.getByRole("button", {
      name: /Saturday, 2 May 2026, 6 captures/i,
    });
    await user.click(activeDay);
    expect(await screen.findByRole("dialog")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open untitled.md" }));
    expect(onOpenPage).toHaveBeenCalledWith("untitled.md", "untitled.md");

    await user.click(activeDay);
    expect(await screen.findByRole("dialog")).toBeVisible();
    await user.click(document.body);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("renders future placeholders inert and preserves the heatmap summary", () => {
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    expect(
      screen.queryByRole("button", { name: /4 May 2026/i }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/4 May 2026/i)).not.toBeInTheDocument();
    expect(screen.getByText("APR")).toBeVisible();
    expect(screen.getByText("MAY")).toBeVisible();
    expect(screen.getByText("1,234")).toBeVisible();
    expect(screen.getByText("9d")).toBeVisible();
    expect(screen.getByText("2d")).toBeVisible();
  });
});

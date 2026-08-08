import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActivityHeatmap } from "./ActivityHeatmap";
import type { HeatmapDay, HeatmapPage } from "./atrium-data";

function page(
  index: number,
  title: string | null = `Page ${index}`,
): HeatmapPage {
  return {
    path: title === null ? "untitled.md" : `page-${index}.md`,
    title,
    activityAt: `2026-05-02T0${index}:00:00Z`,
  };
}

function day(date: string, overrides: Partial<HeatmapDay> = {}): HeatmapDay {
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

afterEach(() => vi.restoreAllMocks());

function mockRect(element: HTMLElement, x: number) {
  element.getBoundingClientRect = () =>
    ({
      x,
      y: 100,
      top: 100,
      right: x + 10,
      bottom: 110,
      left: x,
      width: 10,
      height: 10,
      toJSON: () => ({}),
    }) as DOMRect;
}

function positionedX(element: HTMLElement): number {
  const translatedX = element.style.transform.match(
    /translate\(([-\d.]+)px/,
  )?.[1];
  return Number.parseFloat(translatedX ?? element.style.left);
}

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
    await screen.findByRole("dialog");
    expect(emptyDay).toHaveFocus();
    expect(emptyDay).toHaveClass("focus-visible:outline-2");
    expect(screen.getByText("0 captures")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^Open / }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });

  it("stays open when the pointer leaves a focused day", async () => {
    const user = userEvent.setup();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    const activeDay = screen.getByRole("button", {
      name: /2 May 2026, 6 captures/i,
    });
    act(() => activeDay.focus());
    const dialog = await screen.findByRole("dialog");

    await user.hover(activeDay);
    await user.unhover(activeDay);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    expect(dialog).toBeVisible();
  });

  it("stays closed after Escape, then reopens on a later focus", async () => {
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
    expect(activeDay).toHaveFocus();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    act(() => {
      activeDay.blur();
      activeDay.focus();
    });
    expect(await screen.findByRole("dialog")).toBeVisible();
  });

  it("stays closed after Escape when pointer entry follows keyboard focus", async () => {
    const user = userEvent.setup();
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    const activeDay = screen.getByRole("button", {
      name: /2 May 2026, 6 captures/i,
    });
    act(() => activeDay.focus());
    await screen.findByRole("dialog");

    await user.hover(activeDay);
    act(() => screen.getByRole("button", { name: "Open Page 2" }).focus());
    await user.keyboard("{Escape}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(activeDay).toHaveFocus();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 150));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
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

  it("keeps one stable popover while hovering from one day to the next", async () => {
    const user = userEvent.setup();
    vi.spyOn(document.documentElement, "clientWidth", "get").mockReturnValue(
      1024,
    );
    vi.spyOn(document.documentElement, "clientHeight", "get").mockReturnValue(
      768,
    );
    render(<ActivityHeatmap {...fixtureProps} onOpenPage={vi.fn()} />);

    const emptyDay = screen.getByRole("button", {
      name: /1 May 2026, 0 captures/i,
    });
    const activeDay = screen.getByRole("button", {
      name: /2 May 2026, 6 captures/i,
    });
    mockRect(emptyDay, 10);
    mockRect(activeDay, 200);

    await user.hover(emptyDay);
    const dialog = await screen.findByRole("dialog", {
      name: /1 May 2026 activity/i,
    });
    const positionedPopover = dialog.closest("[data-placement]") as HTMLElement;
    await waitFor(() => expect(positionedX(positionedPopover)).not.toBeNaN());
    const firstLeft = positionedX(positionedPopover);
    await user.hover(activeDay);

    await waitFor(() =>
      expect(dialog).toHaveAccessibleName(/2 May 2026 activity/i),
    );
    expect(screen.getByText("6 captures")).toBeVisible();
    await waitFor(() =>
      expect(positionedX(positionedPopover)).toBeGreaterThan(firstLeft + 100),
    );
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
    act(() => screen.getByRole("button", { name: "Open Page 2" }).focus());
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

  it("renders duplicate page paths as distinct controls without key warnings", async () => {
    const user = userEvent.setup();
    const onOpenPage = vi.fn();
    const duplicateWeeks = fixtureProps.weeks.map((week) =>
      week.map((candidate) =>
        candidate.date === "2026-05-02"
          ? {
              ...candidate,
              count: 2,
              level: 2,
              pages: [
                {
                  path: "same.md",
                  title: "Earlier copy",
                  activityAt: "2026-05-02T08:00:00Z",
                },
                {
                  path: "same.md",
                  title: "Later copy",
                  activityAt: "2026-05-02T09:00:00Z",
                },
              ],
            }
          : candidate,
      ),
    );
    const errors: unknown[][] = [];
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => errors.push(args));

    try {
      render(
        <ActivityHeatmap
          {...fixtureProps}
          weeks={duplicateWeeks}
          onOpenPage={onOpenPage}
        />,
      );
      const activeDay = screen.getByRole("button", {
        name: /2 May 2026, 2 captures/i,
      });
      await user.hover(activeDay);
      await user.click(
        await screen.findByRole("button", { name: "Open Earlier copy" }),
      );
      expect(onOpenPage).toHaveBeenNthCalledWith(1, "same.md", "Earlier copy");

      await user.hover(activeDay);
      await user.click(
        await screen.findByRole("button", { name: "Open Later copy" }),
      );
      expect(onOpenPage).toHaveBeenNthCalledWith(2, "same.md", "Later copy");

      const duplicateKeyErrors = errors.filter((args) =>
        args.some((part) => String(part).includes("same key")),
      );
      expect(duplicateKeyErrors).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
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

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgendaResponse } from "#/api/tasks";

const m = vi.hoisted(() => ({ toggle: vi.fn(), openTab: vi.fn() }));

vi.mock("#/api/tasks", () => ({
  useToggleTaskStatus: () => ({ mutate: m.toggle, isPending: false }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => m.openTab }));

import { MobileAgenda } from "#/components/mobile/MobileAgenda";

const todo = (content: string, span: number, due?: string) => ({
  kind: "todo" as const,
  content,
  page_path: "notes/a.md",
  page_title: "Stray Thoughts",
  properties: (due ? { due } : {}) as Record<string, string>,
  span_start: span,
  span_end: span + 5,
  status: "todo" as const,
});

const data: AgendaResponse = {
  overdue: [todo("Rebuild icons", 1, "2026-09-22")],
  today: [
    {
      kind: "task",
      id: "00000000-0000-0000-0000-000000000009",
      code: "TSK-brave-finch",
      title: "Book the room",
      path: "tasks/book.md",
      due: "2026-09-25",
      priority: "P1",
      status: "TRIAGE",
    },
  ],
  upcoming: [
    { date: "2026-09-29", items: [todo("Set theme-color", 2, "2026-09-29")] },
    { date: "2026-10-20", items: [todo("Far off", 3, "2026-10-20")] },
  ],
  undated: [todo("Someday", 4)],
};

const agenda = (
  over: Partial<{
    data: AgendaResponse | undefined;
    isLoading: boolean;
    isError: boolean;
  }> = {},
) => ({
  data,
  isLoading: false,
  isError: false,
  ...over,
});

describe("MobileAgenda", () => {
  beforeEach(() => vi.clearAllMocks());

  it("titles the screen with the open count", () => {
    render(<MobileAgenda agenda={agenda()} today="2026-09-25" />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Agenda" }),
    ).toBeVisible();
    expect(screen.getByText("5 open")).toBeVisible();
  });

  it("lists sections in order, overdue in the warning tone", () => {
    render(<MobileAgenda agenda={agenda()} today="2026-09-25" />);
    const headings = screen.getAllByRole("heading", { level: 2 });
    expect(headings.map((h) => h.textContent)).toEqual([
      "Overdue",
      "Today",
      "This week",
      "Later",
      "No date",
    ]);
    expect(headings[0]).toHaveClass("text-hot");
  });

  it("dates upcoming todos and checks them off", async () => {
    render(<MobileAgenda agenda={agenda()} today="2026-09-25" />);
    expect(screen.getByText("29 Sep · Stray Thoughts")).toBeVisible();
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Set theme-color" }),
    );
    expect(m.toggle).toHaveBeenCalledWith({
      pagePath: "notes/a.md",
      spanStart: 2,
      status: "done",
    });
  });

  it("opens a task instead of offering a checkbox", async () => {
    render(<MobileAgenda agenda={agenda()} today="2026-09-25" />);
    const row = screen.getByRole("button", { name: /Book the room/ });
    expect(
      within(row).getByText("TSK-brave-finch · Ready · High"),
    ).toBeVisible();
    expect(
      screen.queryByRole("checkbox", { name: "Book the room" }),
    ).not.toBeInTheDocument();
    await userEvent.click(row);
    expect(m.openTab).toHaveBeenCalledWith(
      "page",
      "tasks/book.md",
      "Book the room",
    );
  });

  it("says when nothing is open", () => {
    render(
      <MobileAgenda
        agenda={agenda({
          data: { overdue: [], today: [], upcoming: [], undated: [] },
        })}
        today="2026-09-25"
      />,
    );
    expect(screen.getByText("Nothing open.")).toBeVisible();
  });

  it("shows loading and error states", () => {
    const { rerender } = render(
      <MobileAgenda
        agenda={agenda({ data: undefined, isLoading: true })}
        today="2026-09-25"
      />,
    );
    expect(screen.getByText("Loading…")).toBeVisible();
    rerender(
      <MobileAgenda
        agenda={agenda({ data: undefined, isError: true })}
        today="2026-09-25"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Agenda failed to load.",
    );
  });
});

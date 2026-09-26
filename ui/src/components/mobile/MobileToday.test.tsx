import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgendaResponse } from "#/api/tasks";

const m = vi.hoisted(() => ({
  journal: { data: null as unknown },
  agenda: { data: undefined as AgendaResponse | undefined },
  reading: [] as Array<{
    id: string;
    path: string;
    title?: string;
    progress?: number | null;
    pages?: number | null;
    author?: string | null;
  }>,
  toggle: vi.fn(),
  openTab: vi.fn(),
  openJournal: vi.fn(),
  openInscribe: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => m.navigate }));
vi.mock("#/api/journal", () => ({ useJournalToday: () => m.journal }));
vi.mock("#/api/tasks", () => ({
  useAgenda: () => m.agenda,
  useToggleTaskStatus: () => ({ mutate: m.toggle, isPending: false }),
}));
vi.mock("#/components/codex/ReadingContinues", () => ({
  useReadingRows: () => m.reading,
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => m.openTab }));
vi.mock("#/hooks/useOpenTodayJournal", () => ({
  useOpenTodayJournal: () => m.openJournal,
}));
vi.mock("#/hooks/useClock", () => ({
  useClock: () => new Date(2026, 8, 25, 9, 0),
}));
vi.mock("#/store/ui", () => ({
  useUiStore: (sel: (s: { openInscribe: () => void }) => unknown) =>
    sel({ openInscribe: m.openInscribe }),
}));

import { MobileToday } from "#/components/mobile/MobileToday";

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

describe("MobileToday", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.journal = { data: null };
    m.agenda = {
      data: {
        overdue: [todo("Rebuild extension icons", 1, "2026-09-22")],
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
        upcoming: [],
        undated: [],
      },
    };
    m.reading = [];
  });

  it("greets with the date and an accented last word", () => {
    render(<MobileToday />);
    expect(screen.getByText("Friday 25 September · Week 39")).toBeVisible();
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1).toHaveTextContent("Good morning.");
    expect(within(h1).getByText("morning.").tagName).toBe("EM");
  });

  it("opens a new note from the capture pill", async () => {
    render(<MobileToday />);
    await userEvent.click(
      screen.getByRole("button", { name: "Capture a thought…" }),
    );
    expect(m.openInscribe).toHaveBeenCalledOnce();
  });

  it("shows the journal excerpt and opens the journal", async () => {
    m.journal = { data: { body: "# Friday\n\nFinished the **chapter**." } };
    render(<MobileToday />);
    expect(screen.getByText("Finished the chapter.")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open journal" }));
    expect(m.openJournal).toHaveBeenCalledOnce();
  });

  it("says when nothing is written yet", () => {
    render(<MobileToday />);
    expect(screen.getByText("Nothing written yet.")).toBeVisible();
  });

  it("lists overdue and today's items and checks a todo off", async () => {
    render(<MobileToday />);
    const overdue = screen.getByText("Overdue · 22 Sep");
    expect(overdue).toHaveClass("text-hot");
    await userEvent.click(
      screen.getByRole("checkbox", { name: "Rebuild extension icons" }),
    );
    expect(m.toggle).toHaveBeenCalledWith(
      { pagePath: "notes/a.md", spanStart: 1, status: "done" },
      expect.anything(),
    );
  });

  it("opens a task's page", async () => {
    render(<MobileToday />);
    await userEvent.click(
      screen.getByRole("button", { name: /Book the room/ }),
    );
    expect(m.openTab).toHaveBeenCalledWith(
      "page",
      "tasks/book.md",
      "Book the room",
    );
  });

  it("caps Due today at five rows and links to the Agenda", async () => {
    m.agenda = {
      data: {
        overdue: Array.from({ length: 7 }, (_, i) => todo(`late ${i}`, i)),
        today: [],
        upcoming: [],
        undated: [],
      },
    };
    render(<MobileToday />);
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
    await userEvent.click(screen.getByRole("button", { name: "Open agenda" }));
    expect(m.navigate).toHaveBeenCalledWith({ to: "/agenda" });
  });

  it("lists pages in progress and omits the section when there are none", async () => {
    const { unmount } = render(<MobileToday />);
    expect(
      screen.queryByRole("heading", { name: "Continue reading" }),
    ).not.toBeInTheDocument();
    unmount();

    m.reading = [
      {
        id: "1",
        path: "books/de.md",
        title: "De architectura",
        progress: 142,
        pages: 331,
      },
    ];
    render(<MobileToday />);
    expect(screen.getByText("p. 142 of 331")).toBeVisible();
    await userEvent.click(
      screen.getByRole("button", { name: /De architectura/ }),
    );
    expect(m.openTab).toHaveBeenCalledWith(
      "page",
      "books/de.md",
      "De architectura",
    );
  });
});

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(async () => {
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
});

import type { BoardResponse, BoardTask } from "#/api/board";

const m = vi.hoisted(() => ({
  board: undefined as unknown,
  create: vi.fn(),
  openTab: vi.fn(),
}));

vi.mock("#/api/board", () => ({
  useBoard: () => ({ data: m.board, isLoading: false, isError: false }),
  useCreateTask: () => ({ mutate: m.create, isPending: false }),
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => m.openTab }));

import { MobileTasking } from "#/components/mobile/MobileTasking";
import { useBoardStore } from "#/store/board";

const task = (
  id: string,
  status: string,
  over: Partial<BoardTask> = {},
): BoardTask =>
  ({
    id,
    code: `TSK-${id}`,
    title: `Task ${id}`,
    path: `tasks/${id}.md`,
    status,
    priority: "P2",
    tags: [],
    checks: [0, 0],
    body_excerpt: "",
    updated_at: "2026-09-01T00:00:00Z",
    project: "clepsydra",
    ...over,
  }) as BoardTask;

function board(over: Partial<BoardResponse> = {}): BoardResponse {
  return {
    columns: [],
    cycles: [
      {
        id: "c1",
        code: "S-quiet-heron",
        label: "Quiet heron",
        path: "cycles/c1.md",
        state: "ACTIVE",
        start: "2026-09-14",
        end: "2026-09-27",
      },
    ],
    operations: [
      {
        id: "o1",
        code: "CLEP",
        name: "Clepsydra",
        path: "projects/clepsydra.md",
        health: "GREEN",
        project: "clepsydra",
      },
    ],
    tasks: [
      task("a", "TRIAGE", {
        cycle: "S-quiet-heron",
        priority: "P0",
        due: "2026-09-29",
      }),
      task("b", "TRIAGE"),
      task("c", "INTAKE", { project: null }),
      task("d", "SEALED", { cycle: "S-quiet-heron" }),
    ],
    ...over,
  } as BoardResponse;
}

describe("MobileTasking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.board = board();
    useBoardStore.setState({ opFilter: "ALL" });
  });

  it("counts tasks per status and opens on Ready", () => {
    render(<MobileTasking />);
    const tabs = screen.getByRole("tablist", { name: "Status" });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual(["Inbox 1", "Ready 2", "In Progress 0", "Review 0", "Done 1"]);
    expect(within(tabs).getByRole("tab", { name: "Ready 2" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("button", { name: /Task a/ })).toBeVisible();
  });

  it("switches status and opens a card's page", async () => {
    render(<MobileTasking />);
    await userEvent.click(screen.getByRole("tab", { name: "Inbox 1" }));
    await userEvent.click(screen.getByRole("button", { name: /Task c/ }));
    expect(m.openTab).toHaveBeenCalledWith("page", "tasks/c.md", "Task c");
  });

  it("titles the scope and narrows tasks to a project", () => {
    useBoardStore.setState({ opFilter: "clepsydra" });
    render(<MobileTasking />);
    expect(
      screen.getByRole("heading", { level: 1, name: "Clepsydra" }),
    ).toBeVisible();
    expect(screen.getByRole("tab", { name: "Inbox 0" })).toBeVisible();
  });

  it("names the all-projects scope", () => {
    render(<MobileTasking />);
    expect(
      screen.getByRole("heading", { level: 1, name: "All projects" }),
    ).toBeVisible();
  });

  it("shows the active cycle's progress", () => {
    render(<MobileTasking />);
    expect(screen.getByText(/Cycle S-quiet-heron/)).toBeVisible();
    const bar = screen.getByRole("progressbar", { name: "Cycle progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "1");
    expect(bar).toHaveAttribute("aria-valuemax", "2");
  });

  it("hides the cycle line without an active cycle", () => {
    m.board = board({ cycles: [] });
    render(<MobileTasking />);
    expect(screen.queryByText(/Cycle /)).not.toBeInTheDocument();
  });

  it("creates a task in the current status and project", async () => {
    useBoardStore.setState({ opFilter: "clepsydra" });
    render(<MobileTasking />);
    await userEvent.click(screen.getByRole("button", { name: "+ New task" }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "New task title" }),
      "Sketch the valve{Enter}",
    );
    expect(m.create).toHaveBeenCalledWith(
      { title: "Sketch the valve", status: "TRIAGE", project: "clepsydra" },
      expect.anything(),
    );
  });
});

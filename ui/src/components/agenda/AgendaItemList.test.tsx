import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgendaTask, AgendaTodo } from "#/api/tasks";
import { AgendaItemList } from "#/components/agenda/AgendaItemList";

const mocks = vi.hoisted(() => ({
  openTab: vi.fn(),
  patchTask: vi.fn(),
  patchTaskPending: false,
  toggleTodo: vi.fn(),
  toggleTodoPending: false,
}));

vi.mock("#/api/tasks", () => ({
  useToggleTaskStatus: () => ({
    mutate: mocks.toggleTodo,
    isPending: mocks.toggleTodoPending,
  }),
}));

vi.mock("#/api/board", () => ({
  usePatchTask: () => ({
    mutate: mocks.patchTask,
    isPending: mocks.patchTaskPending,
  }),
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => mocks.openTab,
}));

const todoFixture: AgendaTodo = {
  block_id: "block-1",
  content: "Ship the source row",
  kind: "todo",
  page_path: "notes/source.md",
  page_title: "Source Folio",
  properties: {
    due: "2026-08-26",
    priority: "A",
  },
  span_end: 31,
  span_start: 12,
  status: "todo",
};

const taskFixture: AgendaTask = {
  code: "TSK-0200",
  due: "2026-08-26",
  hold: "Waiting for review",
  id: "01900000-0000-7000-8000-000000000200",
  kind: "task",
  path: "tasks/agenda/source-row.md",
  priority: "P1",
  project: "agenda",
  status: "FIELD",
  title: "Render source-specific rows",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.patchTaskPending = false;
  mocks.toggleTodoPending = false;
});

describe("AgendaItemList", () => {
  it("renders the supplied empty message", () => {
    render(<AgendaItemList items={[]} emptyMessage="Nothing scheduled." />);

    expect(screen.getByText("Nothing scheduled.")).toBeInTheDocument();
  });

  it("toggles a Todo through the Todo mutation", async () => {
    render(<AgendaItemList items={[todoFixture]} />);

    await userEvent.click(
      screen.getByRole("button", { name: /mark Todo done/i }),
    );

    expect(mocks.toggleTodo).toHaveBeenCalledWith({
      pagePath: "notes/source.md",
      spanStart: 12,
      status: "done",
    });
  });

  it("patches a Task with persisted status ids while showing canonical labels", async () => {
    render(<AgendaItemList items={[taskFixture]} />);

    const status = screen.getByRole("button", { name: /status/i });
    expect(status).toHaveTextContent("In Progress");
    await userEvent.click(status);
    await userEvent.click(screen.getByRole("option", { name: "Done" }));

    expect(mocks.patchTask).toHaveBeenCalledWith({
      id: "01900000-0000-7000-8000-000000000200",
      patch: { status: "SEALED" },
    });
  });

  it("gives each row mutation control a unique accessible name", () => {
    const secondTodo: AgendaTodo = {
      ...todoFixture,
      content: "Review the journal row",
      page_path: "journals/2026-08-26.md",
      page_title: null,
      span_start: 44,
    };
    const secondTask: AgendaTask = {
      ...taskFixture,
      code: "TSK-0201",
      id: "01900000-0000-7000-8000-000000000201",
      title: "Verify accessible controls",
    };

    render(
      <AgendaItemList
        items={[todoFixture, secondTodo, taskFixture, secondTask]}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: "Mark Todo done: Ship the source row (Source Folio)",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "Mark Todo done: Review the journal row (journals/2026-08-26.md)",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "In Progress Status for TSK-0200: Render source-specific rows",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "In Progress Status for TSK-0201: Verify accessible controls",
      }),
    ).toBeVisible();
  });

  it("uses Todo priority ids and Task priority labels", () => {
    const todoB: AgendaTodo = {
      ...todoFixture,
      page_path: "notes/b.md",
      properties: { priority: "B" },
      span_start: 40,
    };
    const todoC: AgendaTodo = {
      ...todoFixture,
      page_path: "notes/c.md",
      properties: { priority: "C" },
      span_start: 60,
    };

    render(
      <AgendaItemList items={[todoFixture, todoB, todoC, taskFixture]} />,
    );

    for (const priority of ["A", "B", "C"]) {
      expect(screen.getByText(priority)).toBeInTheDocument();
    }
    expect(screen.getByText("P1 High")).toBeInTheDocument();
  });

  it("renders Blocked only when a Task hold is non-empty", () => {
    const taskWithoutHold: AgendaTask = {
      ...taskFixture,
      hold: "",
      id: "01900000-0000-7000-8000-000000000201",
      title: "Unblocked task",
    };

    render(<AgendaItemList items={[taskFixture, taskWithoutHold]} />);

    expect(screen.getAllByText("Blocked")).toHaveLength(1);
  });

  it("opens the source Folio for both row kinds", async () => {
    render(<AgendaItemList items={[todoFixture, taskFixture]} />);

    await userEvent.click(
      screen.getByRole("button", { name: "Source Folio" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "tasks/agenda/source-row.md" }),
    );

    expect(mocks.openTab).toHaveBeenNthCalledWith(
      1,
      "page",
      "notes/source.md",
    );
    expect(mocks.openTab).toHaveBeenNthCalledWith(
      2,
      "page",
      "tasks/agenda/source-row.md",
    );
  });

  it("disables only the Todo control while its mutation is pending", () => {
    mocks.toggleTodoPending = true;

    render(<AgendaItemList items={[todoFixture, taskFixture]} />);

    expect(
      screen.getByRole("button", { name: /mark Todo done/i }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: /status/i })).toBeEnabled();
  });

  it("disables only the Task control while its mutation is pending", () => {
    mocks.patchTaskPending = true;

    render(<AgendaItemList items={[todoFixture, taskFixture]} />);

    expect(screen.getByRole("button", { name: /status/i })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /mark Todo done/i }),
    ).toBeEnabled();
  });
});

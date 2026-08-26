/**
 * NewTaskModal tests.
 *
 * Fetch stub pattern: vi.fn() returning a Response-shaped object.
 * Board store is reset before each test via useBoardStore.setState.
 *
 * ⌘↵ shortcut is tested using window keydown events since the handler
 * is registered on the window when the modal is open.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardStore } from "#/store/board";
import { COL_LABEL, type ColLabelFn } from "../board-constants";
import { NewTaskModal } from "../NewTaskModal";
import {
  BOARD_FIXTURE,
  BOARD_FIXTURE_WITH_CLOSED_CYCLE,
  NO_SLUG_OP,
} from "./fixtures";

const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

const { operations, cycles } = BOARD_FIXTURE;
const NEUTRAL_COL_LABEL: ColLabelFn = (id) => COL_LABEL[id] ?? id;

// ── helpers ───────────────────────────────────────────────────────────────────

function wrap(
  fetchStub?: ReturnType<typeof vi.fn>,
  presets?: { project?: string; status?: string; cycle?: string },
) {
  if (fetchStub) vi.stubGlobal("fetch", fetchStub);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  // Open the modal with optional presets
  useBoardStore.setState({
    taskModal: presets ?? {},
  });

  return render(
    <QueryClientProvider client={qc}>
      <NewTaskModal
        colLabel={NEUTRAL_COL_LABEL}
        operations={operations}
        cycles={cycles}
      />
    </QueryClientProvider>,
  );
}

/**
 * Stub that handles:
 *   - POST /api/vault/board/tasks → returns a BoardTask
 *   - GET /api/vault/board → returns BOARD_FIXTURE
 */
function makeCreateStub(taskId = "new-task-id") {
  const newTask = {
    ...BOARD_FIXTURE.tasks[0],
    id: taskId,
    code: "TSK-9999",
    title: "NEW TASK",
  };
  return vi.fn((_url: string, opts?: RequestInit) => {
    if (opts?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(newTask),
      } as Response);
    }
    // GET board (invalidation refetch)
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(BOARD_FIXTURE),
    } as Response);
  });
}

// ── setup/teardown ────────────────────────────────────────────────────────────

beforeEach(() => {
  useBoardStore.setState({
    mode: "card",
    opFilter: "ALL",
    cycleSel: "",
    railOpen: true,
    editTaskId: null,
    taskModal: null,
    cycleModal: null,
  });
  toastError.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ══════════════════════════════════════════════════════════════════════════════
// Render
// ══════════════════════════════════════════════════════════════════════════════

describe("NewTaskModal — render", () => {
  it("renders nothing when taskModal is null", () => {
    // taskModal is null by default from beforeEach
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <NewTaskModal
          colLabel={NEUTRAL_COL_LABEL}
          operations={operations}
          cycles={cycles}
        />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("new-task-modal")).not.toBeInTheDocument();
  });

  it("uses the approved task dialog and project context language", () => {
    wrap();
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    expect(screen.getByText("New task")).toBeInTheDocument();
    expect(screen.getByText(/No project · Create task/)).toBeInTheDocument();
  });

  it("shows the project code in the sub-header when a project preset matches", () => {
    wrap(undefined, { project: "alpha" });
    expect(screen.getByText(/OPS-1 · Create task/)).toBeInTheDocument();
  });

  it("exposes approved field names, choices, and placeholders", async () => {
    wrap();

    expect(screen.getByRole("textbox", { name: "Title" })).toHaveAttribute(
      "placeholder",
      "What needs to be done…",
    );
    expect(
      screen.getByRole("textbox", { name: "Description" }),
    ).toHaveAttribute(
      "placeholder",
      "What the task is and why it matters…",
    );
    expect(screen.getByRole("radiogroup", { name: "Status" })).toBeInTheDocument();
    expect(
      screen.getByRole("radiogroup", { name: "Priority" }),
    ).toBeInTheDocument();
    for (const name of [
      "Assignee",
      "Estimate",
      "Start date",
      "Due date",
      "Tags",
      "Checklist",
      "Related page",
    ]) {
      expect(screen.getByLabelText(name)).toBeInTheDocument();
    }

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Project$/ }));
    expect(
      screen.getByRole("option", { name: "No project" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /Cycle$/ }));
    expect(screen.getByRole("option", { name: "Backlog" })).toBeInTheDocument();
  });

  it("presets the Status radio to the given status", () => {
    wrap(undefined, { status: "FIELD" });
    const status = screen.getByRole("radiogroup", {
      name: "Status",
    });
    const fieldRadio = within(status).getByRole("radio", {
      name: "In Progress",
    });
    expect(fieldRadio).toBeChecked();
    const fieldLabel = fieldRadio.closest("label");
    expect(fieldLabel).toHaveClass(
      "ml-0",
      "data-[selected]:border-[var(--ink)]",
      "data-[selected]:bg-[var(--ink)]",
      "data-[selected]:font-normal",
      "data-[selected]:text-[var(--bg)]",
    );
    expect(fieldLabel).not.toHaveClass(
      "-ml-px",
      "data-[hovered]:bg-accent",
      "data-[selected]:bg-accent",
      "data-[selected]:font-bold",
    );
    // Active state: has bg-[var(--ink)] class from RADIO_CLS_ON
    expect(fieldLabel?.className).toContain("bg-[var(--ink)]");
  });

  it("defaults Status to Inbox when no status preset", () => {
    wrap();
    const intakeRadio = screen.getByTestId("new-task-status-INTAKE");
    expect(intakeRadio.closest("label")?.className).toContain(
      "bg-[var(--ink)]",
    );
  });

  it("presets CYCLE select to preset cycle code", () => {
    wrap(undefined, { cycle: "C-01" });
    expect(screen.getByRole("button", { name: /Cycle/ })).toHaveTextContent(
      "C-01 · Cycle 01 (Active)",
    );
  });

  it("defaults Cycle to Backlog when no cycle preset", () => {
    wrap();
    expect(screen.getByRole("button", { name: /Cycle$/ })).toHaveTextContent(
      "Backlog",
    );
  });

  it("defaults PRIORITY to P2 and supports arrow-key selection", async () => {
    wrap();
    await waitFor(() =>
      expect(screen.getByTestId("new-task-title")).toHaveFocus(),
    );
    const priority = screen.getByRole("radiogroup", { name: "Priority" });
    const p2 = within(priority).getByRole("radio", { name: "P2 Medium" });
    expect(p2).toBeChecked();
    const p2Label = p2.closest("label");
    // Active state: has cool background
    expect(p2Label).toHaveStyle({ background: "var(--cool)" });
    expect(p2Label).toHaveClass(
      "ml-0",
      "data-[hovered]:bg-transparent",
      "data-[selected]:bg-transparent",
      "data-[selected]:font-normal",
    );
    expect(p2Label).not.toHaveClass(
      "-ml-px",
      "data-[hovered]:bg-accent",
      "data-[selected]:bg-accent",
      "data-[selected]:font-bold",
    );

    const user = userEvent.setup();
    p2.focus();
    expect(p2).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(
      within(priority).getByRole("radio", { name: "P1 High" }),
    ).toBeChecked();
  });

  it("lists all projects in the Project select", async () => {
    wrap();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Project$/ }));
    expect(
      screen.getByRole("option", { name: "OPS-1 — Operation Alpha" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "OPS-2 — Operation Beta" }),
    ).toBeInTheDocument();
  });

  it("lists cycles with neutral state labels while retaining code values", async () => {
    wrap();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Cycle$/ }));
    expect(
      screen.getByRole("option", { name: "C-01 · Cycle 01 (Active)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "C-02 · Cycle 02 (Planned)" }),
    ).toBeInTheDocument();
  });

  it("omits CLOSED cycles from the CYCLE dropdown", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useBoardStore.setState({ taskModal: {} });
    render(
      <QueryClientProvider client={qc}>
        <NewTaskModal
          colLabel={NEUTRAL_COL_LABEL}
          operations={BOARD_FIXTURE_WITH_CLOSED_CYCLE.operations}
          cycles={BOARD_FIXTURE_WITH_CLOSED_CYCLE.cycles}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Cycle$/ }));
    expect(
      screen.getByRole("option", { name: "C-01 · Cycle 01 (Active)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "C-02 · Cycle 02 (Planned)" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /C-00/ }),
    ).not.toBeInTheDocument();
  });

  it("DUE input is a date field", () => {
    wrap();
    const dueInput = screen.getByTestId<HTMLInputElement>("new-task-due");
    expect(dueInput).toHaveAttribute("type", "date");
  });

  it("START input is a date field", () => {
    wrap();
    const startInput = screen.getByTestId<HTMLInputElement>("new-task-start");
    expect(startInput).toHaveAttribute("type", "date");
  });

  it("omits slug-less operations from the OPERATION dropdown", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useBoardStore.setState({ taskModal: {} });
    render(
      <QueryClientProvider client={qc}>
        <NewTaskModal
          colLabel={NEUTRAL_COL_LABEL}
          operations={[...operations, NO_SLUG_OP]}
          cycles={cycles}
        />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Project$/ }));
    expect(
      screen.getByRole("option", { name: "OPS-1 — Operation Alpha" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /OPS-3/ }),
    ).not.toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Submit — POST payload shape
// ══════════════════════════════════════════════════════════════════════════════

describe("NewTaskModal — submit payload", () => {
  it("commits POST with full payload when all fields filled", async () => {
    const stub = makeCreateStub();
    wrap(stub);

    const user = userEvent.setup();

    // Fill in all fields
    await user.clear(screen.getByTestId("new-task-title"));
    await user.type(screen.getByTestId("new-task-title"), "My Task");

    // Select operation "alpha" (OPS-1)
    await user.click(screen.getByRole("button", { name: /Project$/ }));
    await user.click(
      screen.getByRole("option", { name: "OPS-1 — Operation Alpha" }),
    );

    await user.click(screen.getByRole("button", { name: /Cycle$/ }));
    await user.click(
      screen.getByRole("option", { name: "C-01 · Cycle 01 (Active)" }),
    );

    // Rendered status and priority labels still submit raw IDs.
    await user.click(screen.getByRole("radio", { name: "In Progress" }));
    await user.click(screen.getByRole("radio", { name: "P1 High" }));

    // Fill text fields
    await user.type(screen.getByTestId("new-task-assignee"), "Kit");
    await user.type(screen.getByTestId("new-task-estimate"), "2h");
    await user.type(screen.getByTestId("new-task-start"), "2026-08-01");
    await user.type(screen.getByTestId("new-task-due"), "2026-12-31");
    await user.type(screen.getByTestId("new-task-tags"), "INFRA, DOCS");
    // Note: userEvent interprets "[" as a special key modifier.
    // Use paste or fireEvent.change to inject wikilink syntax reliably.
    const linkInput = screen.getByTestId("new-task-link");
    await user.click(linkInput);
    await user.paste("[[alpha-dossier]]");

    // Brief: prose that becomes the page body above the checklist
    await user.type(
      screen.getByTestId("new-task-brief"),
      "Why this matters.",
    );

    // Checklist: two lines
    await user.type(
      screen.getByTestId("new-task-checklist"),
      "item one{Enter}item two",
    );

    await user.click(screen.getByTestId("new-task-commit"));

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "POST",
      );
      expect(postCalls.length).toBeGreaterThan(0);
      const body = JSON.parse(postCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.title).toBe("My Task");
      expect(body.project).toBe("alpha");
      expect(body.status).toBe("FIELD");
      expect(body.priority).toBe("P1");
      expect(body.cycle).toBe("C-01");
      expect(body.assignee).toBe("Kit");
      expect(body.estimate).toBe("2h");
      expect(body.start).toBe("2026-08-01");
      expect(body.due).toBe("2026-12-31");
      expect(body.tags).toEqual(["INFRA", "DOCS"]);
      expect(body.link).toBe("[[alpha-dossier]]");
      expect(body.checklist).toEqual(["item one", "item two"]);
      expect(body.body).toBe("Why this matters.");
    });
  });

  it("omits an untouched brief from the payload", async () => {
    const stub = makeCreateStub();
    wrap(stub);

    const user = userEvent.setup();
    await user.type(screen.getByTestId("new-task-title"), "Brief-less");
    await user.type(screen.getByTestId("new-task-brief"), "   ");
    await user.click(screen.getByTestId("new-task-commit"));

    await waitFor(() => {
      const post = stub.mock.calls.find(([, opts]) => opts?.method === "POST");
      expect(post).toBeDefined();
      const body = JSON.parse(post?.[1]?.body as string) as Record<
        string,
        unknown
      >;
      expect(body.body).toBeNull();
    });
  });

  it("commit button is disabled when title is empty", () => {
    const stub = makeCreateStub();
    wrap(stub);

    const commitBtn = screen.getByTestId<HTMLButtonElement>("new-task-commit");
    expect(commitBtn).toBeDisabled();
  });

  it("clicking commit button when title is empty does not fire POST", async () => {
    const stub = makeCreateStub();
    stub.mockClear();
    wrap(stub);

    // Title is empty by default
    const commitBtn = screen.getByTestId<HTMLButtonElement>("new-task-commit");
    expect(commitBtn).toBeDisabled();

    // Try to click (it won't fire due to disabled state)
    await userEvent.click(commitBtn);

    const postCalls = stub.mock.calls.filter(
      ([, opts]) => opts?.method === "POST",
    );
    expect(postCalls.length).toBe(0);
  });

  it("sends cycle as null when BACKLOG is selected", async () => {
    const stub = makeCreateStub();
    wrap(stub);

    // Add a title so commit is enabled
    await userEvent.type(screen.getByTestId("new-task-title"), "Test Task");

    // BACKLOG is the default; click commit directly
    await userEvent.click(screen.getByTestId("new-task-commit"));

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "POST",
      );
      const body = JSON.parse(postCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.cycle).toBeNull();
    });
  });

  it("sends project as null when No project is selected", async () => {
    const stub = makeCreateStub();
    wrap(stub);

    // Add a title so the action is enabled
    await userEvent.type(screen.getByTestId("new-task-title"), "Test Task");

    await userEvent.click(screen.getByRole("button", { name: /Project$/ }));
    await userEvent.click(screen.getByRole("option", { name: "No project" }));
    await userEvent.click(screen.getByTestId("new-task-commit"));

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "POST",
      );
      const body = JSON.parse(postCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.project).toBeNull();
    });
  });

  it("sends null for empty optional fields (no noise on the wire)", async () => {
    const stub = makeCreateStub();
    wrap(stub);

    // Add a title so commit is enabled
    await userEvent.type(screen.getByTestId("new-task-title"), "Test Task");

    await userEvent.click(screen.getByTestId("new-task-commit"));

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "POST",
      );
      const body = JSON.parse(postCalls[0][1]!.body as string) as Record<
        string,
        unknown
      >;
      expect(body.assignee).toBeNull();
      expect(body.estimate).toBeNull();
      expect(body.start).toBeNull();
      expect(body.due).toBeNull();
      expect(body.tags).toBeNull();
      expect(body.link).toBeNull();
      expect(body.checklist).toBeNull();
    });
  });
});

describe("NewTaskModal — action feedback", () => {
  it("shows Create task and Cancel actions", () => {
    wrap();
    expect(
      screen.getByRole("button", { name: "Create task" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
  });

  it("shows Creating… while the POST is pending", async () => {
    const pending = new Promise<Response>(() => undefined);
    const stub = vi.fn((_url: string, opts?: RequestInit) => {
      if (opts?.method === "POST") return pending;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(BOARD_FIXTURE),
      } as Response);
    });
    wrap(stub);
    await userEvent.type(screen.getByLabelText("Title"), "Pending task");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Creating…" }),
      ).toBeDisabled(),
    );
  });

  it("reports a create failure with action-specific feedback", async () => {
    const stub = vi.fn((_url: string, opts?: RequestInit) =>
      Promise.resolve({
        ok: opts?.method !== "POST",
        json: () => Promise.resolve(BOARD_FIXTURE),
      } as Response),
    );
    wrap(stub);
    await userEvent.type(screen.getByLabelText("Title"), "Failed task");
    await userEvent.click(screen.getByRole("button", { name: "Create task" }));
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith("Couldn’t create task"),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// ⌘↵ shortcut
// ══════════════════════════════════════════════════════════════════════════════

describe("NewTaskModal — ⌘↵ shortcut", () => {
  it("⌘↵ commits the form from anywhere in the modal", async () => {
    const stub = makeCreateStub();
    wrap(stub);

    const user = userEvent.setup();
    await user.type(screen.getByTestId("new-task-title"), "Shortcut Task");

    // Focus away from title then fire ⌘↵
    await user.click(screen.getByTestId("new-task-assignee"));
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    await waitFor(() => {
      const postCalls = stub.mock.calls.filter(
        ([, opts]) => opts?.method === "POST",
      );
      expect(postCalls.length).toBe(1);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Close behaviour
// ══════════════════════════════════════════════════════════════════════════════

describe("NewTaskModal — close behaviour", () => {
  it("ESC closes without firing POST", async () => {
    const stub = makeCreateStub();
    stub.mockClear();
    wrap(stub);

    const user = userEvent.setup();
    await user.keyboard("{Escape}");

    expect(useBoardStore.getState().taskModal).toBeNull();

    const postCalls = stub.mock.calls.filter(
      ([, opts]) => opts?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("CANCEL button closes without firing POST", async () => {
    const stub = makeCreateStub();
    stub.mockClear();
    wrap(stub);

    await userEvent.click(screen.getByTestId("new-task-cancel"));

    expect(useBoardStore.getState().taskModal).toBeNull();
    const postCalls = stub.mock.calls.filter(
      ([, opts]) => opts?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  it("ESC button in header closes the modal", async () => {
    wrap();
    await userEvent.click(screen.getByTestId("new-task-close-btn"));
    expect(useBoardStore.getState().taskModal).toBeNull();
  });

  it("clicking the backdrop closes the modal when form is pristine", async () => {
    wrap();
    await userEvent.click(screen.getByTestId("new-task-modal-backdrop"));
    expect(useBoardStore.getState().taskModal).toBeNull();
  });

  it("clicking the backdrop does NOT close the modal when form is dirty", async () => {
    wrap();
    // Make form dirty by filling a field
    await userEvent.type(screen.getByTestId("new-task-assignee"), "Kit");

    // Try to close via backdrop
    await userEvent.click(screen.getByTestId("new-task-modal-backdrop"));

    // Modal should still be open
    expect(screen.getByTestId("new-task-modal")).toBeInTheDocument();
    expect(useBoardStore.getState().taskModal).not.toBeNull();
  });

  it("ESC always closes the modal even when dirty", async () => {
    wrap();
    // Make form dirty by filling a field
    await userEvent.type(screen.getByTestId("new-task-assignee"), "Kit");

    // ESC should still close
    await userEvent.keyboard("{Escape}");

    expect(useBoardStore.getState().taskModal).toBeNull();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Success → closeTaskModal + setEditTaskId
// ══════════════════════════════════════════════════════════════════════════════

describe("NewTaskModal — success callback", () => {
  it("on success: closes modal and sets editTaskId to the new task id", async () => {
    const stub = makeCreateStub("new-task-abc");
    wrap(stub);

    // Add a title so commit is enabled
    await userEvent.type(screen.getByTestId("new-task-title"), "New Task");

    await userEvent.click(screen.getByTestId("new-task-commit"));

    await waitFor(() => {
      expect(useBoardStore.getState().taskModal).toBeNull();
      expect(useBoardStore.getState().editTaskId).toBe("new-task-abc");
    });
  });
});

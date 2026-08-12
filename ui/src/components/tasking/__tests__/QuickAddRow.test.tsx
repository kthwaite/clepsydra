/**
 * QuickAddRow tests.
 *
 * Tests the quick-add inline task creation component used in kanban columns
 * and backlog.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QuickAddRow } from "../QuickAddRow";

// ── helpers ───────────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement, fetchStub?: ReturnType<typeof vi.fn>) {
  if (fetchStub) vi.stubGlobal("fetch", fetchStub);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function makeCreateStub() {
  return vi.fn((_url: string, opts?: RequestInit) => {
    if (opts?.method === "POST") {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: "new-task-id",
          code: "TSK-9999",
          title: "New Task",
          status: "INTAKE",
          priority: null,
          project: null,
          cycle: null,
          tags: [],
          checks: [],
          path: "tasks/new-task.md",
          updated_at: new Date().toISOString(),
        }),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);
  });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ══════════════════════════════════════════════════════════════════════════════
// QuickAddRow
// ══════════════════════════════════════════════════════════════════════════════

describe("QuickAddRow", () => {
  it("renders an input with placeholder '+ ADD'", () => {
    wrap(<QuickAddRow preset={{}} testId="qa-test" />);
    const input = screen.getByTestId("qa-test");
    expect(input).toHaveAttribute("placeholder", "+ ADD");
  });

  it("allows typing a title", async () => {
    wrap(<QuickAddRow preset={{}} testId="qa-test" />);
    const input = screen.getByTestId("qa-test") as HTMLInputElement;
    await userEvent.type(input, "My task");
    expect(input.value).toBe("My task");
  });

  it("POSTs a task with title, preset status/project, and priority: null on Enter", async () => {
    const stub = makeCreateStub();
    wrap(
      <QuickAddRow
        preset={{ status: "FIELD", project: "alpha" }}
        testId="qa-test"
      />,
      stub,
    );

    const input = screen.getByTestId("qa-test");
    await userEvent.type(input, "New task title");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(stub).toHaveBeenCalledWith(
        expect.stringContaining("/api/vault/board/tasks"),
        expect.objectContaining({
          method: "POST",
          headers: { "Content-Type": "application/json" },
        }),
      );
    });

    const callBody = JSON.parse((stub.mock.calls[0][1] as any).body);
    expect(callBody).toMatchObject({
      title: "New task title",
      status: "FIELD",
      project: "alpha",
      priority: null,
      assignee: null,
      estimate: null,
      due: null,
      start: null,
      tags: null,
      link: null,
      checklist: null,
    });
  });

  it("clears the input and keeps focus on successful POST", async () => {
    const stub = makeCreateStub();
    wrap(
      <QuickAddRow preset={{ status: "INTAKE" }} testId="qa-test" />,
      stub,
    );

    const input = screen.getByTestId("qa-test") as HTMLInputElement;
    await userEvent.type(input, "Task one");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      expect(input.value).toBe("");
      expect(document.activeElement).toBe(input);
    });
  });

  it("does not POST when title is empty", async () => {
    const stub = makeCreateStub();
    wrap(<QuickAddRow preset={{}} testId="qa-test" />, stub);

    screen.getByTestId("qa-test");
    await userEvent.keyboard("{Enter}");

    expect(stub).not.toHaveBeenCalled();
  });

  it("does not POST when title is only whitespace", async () => {
    const stub = makeCreateStub();
    wrap(<QuickAddRow preset={{}} testId="qa-test" />, stub);

    const input = screen.getByTestId("qa-test");
    await userEvent.type(input, "   ");
    await userEvent.keyboard("{Enter}");

    expect(stub).not.toHaveBeenCalled();
  });

  it("clears and blurs on Escape", async () => {
    wrap(<QuickAddRow preset={{}} testId="qa-test" />);

    const input = screen.getByTestId("qa-test") as HTMLInputElement;
    await userEvent.type(input, "Some text");
    expect(input.value).toBe("Some text");

    input.focus();
    await userEvent.keyboard("{Escape}");

    expect(input.value).toBe("");
    expect(document.activeElement).not.toBe(input);
  });

  it("includes preset cycle when provided", async () => {
    const stub = makeCreateStub();
    wrap(
      <QuickAddRow
        preset={{ status: "TRIAGE", cycle: "C-01" }}
        testId="qa-test"
      />,
      stub,
    );

    const input = screen.getByTestId("qa-test");
    await userEvent.type(input, "Cycled task");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      const callBody = JSON.parse((stub.mock.calls[0][1] as any).body);
      expect(callBody.cycle).toBe("C-01");
    });
  });

  it("sends null for preset fields not provided", async () => {
    const stub = makeCreateStub();
    wrap(<QuickAddRow preset={{}} testId="qa-test" />, stub);

    const input = screen.getByTestId("qa-test");
    await userEvent.type(input, "Unfiltered task");
    await userEvent.keyboard("{Enter}");

    await waitFor(() => {
      const callBody = JSON.parse((stub.mock.calls[0][1] as any).body);
      expect(callBody.status).toBe(null);
      expect(callBody.project).toBe(null);
      expect(callBody.cycle).toBe(null);
    });
  });
});

/**
 * InlineEditPopover tests.
 *
 * Covers:
 *   - status field: clicking a DispositionRow column fires PATCH {status}
 *   - priority field: clicking a PriorityRow entry fires PATCH {priority}
 *   - Escape closes the popover without firing a PATCH
 *   - regression: a keydown the chip doesn't itself handle (e.g. a global
 *     shortcut key) must still reach the window-level shortcut dispatcher —
 *     a blanket stopPropagation guard on the chip previously swallowed it
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BoardTask } from "#/api/board";
import { InlineEditPopover } from "../InlineEditPopover";
import { FIXTURE_COL_LABEL } from "./fixtures";

const TASK: BoardTask = {
  id: "t-inline",
  code: "TSK-0100",
  title: "Inline Task",
  body_excerpt: null,
  status: "TRIAGE",
  priority: "P2",
  tags: [],
  checks: [],
  path: "tasks/t-inline.md",
  updated_at: "2026-06-10T00:00:00Z",
};

// ── helpers ───────────────────────────────────────────────────────────────────

function wrap(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

/**
 * Stub that handles PATCH /api/vault/board/tasks/{id} → returns the patched
 * task, and GET /api/vault/board → an empty board (satisfies useBoard-style
 * fetches; InlineEditPopover itself only issues PATCH).
 */
function makeStub() {
  return vi.fn((_url: string, opts?: RequestInit) => {
    if (opts?.method === "PATCH") {
      const p = JSON.parse(opts.body as string);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ...TASK, ...p }),
      } as Response);
    }
    return Promise.resolve({
      ok: true,
      json: () =>
        Promise.resolve({ columns: [], operations: [], cycles: [], tasks: [] }),
    } as Response);
  });
}

function patchCallsFrom(stub: ReturnType<typeof makeStub>) {
  return stub.mock.calls.filter(([, opts]) => opts?.method === "PATCH");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ══════════════════════════════════════════════════════════════════════════════
// status field
// ══════════════════════════════════════════════════════════════════════════════

describe("InlineEditPopover — status", () => {
  it("patches status from the popover", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub);
    const user = userEvent.setup();

    wrap(
      <InlineEditPopover
        task={TASK}
        field="status"
        testIdPrefix="kb"
        colLabel={FIXTURE_COL_LABEL}
      >
        <span>pip</span>
      </InlineEditPopover>,
    );

    await user.click(screen.getByTestId(`kb-inline-status-${TASK.id}`));
    await user.click(screen.getByTestId("inline-status-FIELD"));

    await waitFor(() => {
      expect(patchCallsFrom(stub).length).toBeGreaterThan(0);
    });
    const [url, opts] = patchCallsFrom(stub)[0];
    expect(url).toContain(`/tasks/${TASK.id}`);
    expect(opts).toEqual(
      expect.objectContaining({ body: JSON.stringify({ status: "FIELD" }) }),
    );
  });

  it("closes the popover after committing a status change", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub);
    const user = userEvent.setup();

    wrap(
      <InlineEditPopover
        task={TASK}
        field="status"
        testIdPrefix="kb"
        colLabel={FIXTURE_COL_LABEL}
      >
        <span>pip</span>
      </InlineEditPopover>,
    );

    await user.click(screen.getByTestId(`kb-inline-status-${TASK.id}`));
    await user.click(screen.getByTestId("inline-status-FIELD"));

    await waitFor(() => {
      expect(
        screen.queryByTestId("inline-status-FIELD"),
      ).not.toBeInTheDocument();
    });
  });

  it("Escape closes the popover without firing a PATCH", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub);
    const user = userEvent.setup();

    wrap(
      <InlineEditPopover
        task={TASK}
        field="status"
        testIdPrefix="kb"
        colLabel={FIXTURE_COL_LABEL}
      >
        <span>pip</span>
      </InlineEditPopover>,
    );

    await user.click(screen.getByTestId(`kb-inline-status-${TASK.id}`));
    expect(screen.getByTestId("inline-status-FIELD")).toBeInTheDocument();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.queryByTestId("inline-status-FIELD"),
      ).not.toBeInTheDocument();
    });
    expect(patchCallsFrom(stub)).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// priority field
// ══════════════════════════════════════════════════════════════════════════════

describe("InlineEditPopover — priority", () => {
  it("patches priority from the popover", async () => {
    const stub = makeStub();
    vi.stubGlobal("fetch", stub);
    const user = userEvent.setup();

    wrap(
      <InlineEditPopover
        task={TASK}
        field="priority"
        testIdPrefix="bk"
        colLabel={FIXTURE_COL_LABEL}
      >
        <span>P2</span>
      </InlineEditPopover>,
    );

    await user.click(screen.getByTestId(`bk-inline-priority-${TASK.id}`));
    await user.click(screen.getByTestId("inline-priority-P1"));

    await waitFor(() => {
      expect(patchCallsFrom(stub).length).toBeGreaterThan(0);
    });
    const [url, opts] = patchCallsFrom(stub)[0];
    expect(url).toContain(`/tasks/${TASK.id}`);
    expect(opts).toEqual(
      expect.objectContaining({ body: JSON.stringify({ priority: "P1" }) }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// global shortcut passthrough (regression)
// ══════════════════════════════════════════════════════════════════════════════

describe("InlineEditPopover — global shortcut passthrough", () => {
  it("does not swallow a keydown RAC's press handling doesn't itself act on", () => {
    wrap(
      <InlineEditPopover
        task={TASK}
        field="status"
        testIdPrefix="kb"
        colLabel={FIXTURE_COL_LABEL}
      >
        <span>pip</span>
      </InlineEditPopover>,
    );

    const trigger = screen.getByTestId(`kb-inline-status-${TASK.id}`);
    trigger.focus();
    expect(trigger).toHaveFocus();

    // "k" is not Enter/Space, so RAC's usePress never calls stopPropagation
    // on it — the only thing that could swallow it is a guard we wrote.
    const onWindowKeyDown = vi.fn();
    window.addEventListener("keydown", onWindowKeyDown);
    try {
      fireEvent.keyDown(trigger, { key: "k", code: "KeyK" });
      expect(onWindowKeyDown).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onWindowKeyDown);
    }
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// stacking (regression: chips rendered over the sticky list-view rows)
// ══════════════════════════════════════════════════════════════════════════════

describe("InlineEditPopover — stacking", () => {
  it("lifts the trigger above the row's open button but below the sticky rows", () => {
    wrap(
      <InlineEditPopover
        task={TASK}
        field="status"
        testIdPrefix="bk"
        colLabel={FIXTURE_COL_LABEL}
      >
        <span>pip</span>
      </InlineEditPopover>,
    );

    const trigger = screen.getByTestId(`bk-inline-status-${TASK.id}`);
    // The list view's sticky rows sit at z-[4] (quick-add bar), z-[3]
    // (column header), z-[4] (priority group rows), and the kanban column
    // header at z-[2]. Each list row's open-card button is `absolute inset-0
    // z-0`, so the chip only needs to clear that — a Tailwind z-10 (or
    // higher) would paint the chip over the sticky rows as they scroll past.
    expect(trigger.className).not.toMatch(/\bz-(?:10|20|30|40|50)\b/);
    expect(trigger.className).toContain("z-[1]");
  });
});

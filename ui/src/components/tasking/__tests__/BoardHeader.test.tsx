import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_FILTER_STATE,
  type FilterField,
  FLAG_ON,
} from "#/lib/filters/model";
import { useBoardStore } from "#/store/board";
import { BoardHeader } from "../BoardHeader";
import { BOARD_FIXTURE } from "./fixtures";

const { operations, cycles, tasks } = BOARD_FIXTURE;

const FILTER_FIELDS: FilterField[] = [
  {
    id: "project",
    kind: "multi",
    label: "PROJECT",
    options: [{ value: "alpha" }, { value: "beta" }],
  },
  {
    id: "pri",
    kind: "multi",
    label: "PRI",
    options: [
      { value: "P0" },
      { value: "P1" },
      { value: "P2" },
      { value: "P3" },
    ],
  },
  { id: "hold", kind: "flag", label: "ON HOLD", options: [] },
];

/** Renders BoardHeader with sane fixture defaults, overridable per test. */
function renderHeader(
  overrides: Partial<ComponentProps<typeof BoardHeader>> = {},
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
        filterFields={FILTER_FIELDS}
        filterState={EMPTY_FILTER_STATE}
        onFilterChange={vi.fn()}
        {...overrides}
      />
    </QueryClientProvider>,
  );
}

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
});

describe("BoardHeader", () => {
  // ── title block ────────────────────────────────────────────────────────────

  it("renders TASKING BOARD heading", () => {
    renderHeader();
    expect(
      screen.getByRole("heading", { name: /TASKING BOARD/i }),
    ).toBeInTheDocument();
  });

  it("renders OPS REGISTER label with correct counts", () => {
    renderHeader();
    expect(screen.getByText(/2 OPERATIONS/)).toBeInTheDocument();
    expect(screen.getByText(/2 CYCLES/)).toBeInTheDocument();
  });

  // ── stat computation ───────────────────────────────────────────────────────

  it("computes OPEN count (non-SEALED tasks)", () => {
    // tasks has 4 non-SEALED (t1 FIELD, t2 INTAKE, t3 TRIAGE, t4 INTAKE) + 1 SEALED (t5)
    renderHeader();
    // "04" = 4 open tasks
    const openLabel = screen.getByText("OPEN");
    const openStat = openLabel.parentElement!.querySelector("span:last-child");
    expect(openStat?.textContent).toBe("04");
  });

  it("computes IN-FIELD count zero-padded", () => {
    // t1 has status=FIELD
    renderHeader();
    const fieldLabel = screen.getByText("IN-FIELD");
    const fieldStat =
      fieldLabel.parentElement!.querySelector("span:last-child");
    expect(fieldStat?.textContent).toBe("01");
  });

  it("computes ON HOLD count zero-padded", () => {
    // t2 has hold='blocker'
    renderHeader();
    const holdLabel = screen.getByText("ON HOLD");
    const holdStat = holdLabel.parentElement!.querySelector("span:last-child");
    expect(holdStat?.textContent).toBe("01");
  });

  it("ON HOLD stat uses hot color when count > 0", () => {
    renderHeader();
    const holdLabel = screen.getByText("ON HOLD");
    const holdStat = holdLabel.parentElement!.querySelector(
      "span:last-child",
    ) as HTMLElement;
    expect(holdStat?.style.color).toBe("var(--hot)");
  });

  it("ON HOLD stat uses ink color when count is 0", () => {
    const noHoldTasks = tasks.filter((t) => !t.hold);
    renderHeader({
      tasks: noHoldTasks,
      filteredCount: noHoldTasks.length,
      opFilteredCount: noHoldTasks.length,
    });
    const holdLabel = screen.getByText("ON HOLD");
    const holdStat = holdLabel.parentElement!.querySelector(
      "span:last-child",
    ) as HTMLElement;
    expect(holdStat?.style.color).toBe("var(--ink)");
  });

  it("renders SEAL RATE 14d sparkline", () => {
    renderHeader({ sealHistory: [0, 1, 2] });
    expect(screen.getByText("SEAL RATE 14d")).toBeInTheDocument();
    // SVG polyline is present
    expect(document.querySelector("polyline")).toBeInTheDocument();
  });

  // ── mode toggles ───────────────────────────────────────────────────────────

  it("renders all 4 mode buttons", () => {
    renderHeader();
    expect(screen.getByRole("tab", { name: /CARD/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /BACKLOG/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /CYCLE/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /TIMELINE/ })).toBeInTheDocument();
  });

  it("clicking a mode button updates store mode", async () => {
    renderHeader();
    const backlogBtn = screen.getByRole("tab", { name: /BACKLOG/ });
    await userEvent.click(backlogBtn);
    expect(useBoardStore.getState().mode).toBe("backlog");
  });

  it("active mode tab has aria-selected=true", () => {
    useBoardStore.setState({ mode: "backlog" });
    renderHeader();
    const backlogBtn = screen.getByRole("tab", { name: /BACKLOG/ });
    expect(backlogBtn).toHaveAttribute("aria-selected", "true");
  });

  // ── op-meta line ───────────────────────────────────────────────────────────

  it("does NOT render op-meta line when activeOp is null", () => {
    renderHeader();
    expect(screen.queryByText("LEAD")).not.toBeInTheDocument();
    expect(screen.queryByText("HEALTH")).not.toBeInTheDocument();
  });

  it("renders op-meta line when activeOp is set", () => {
    const activeOp = operations[0]; // Operation Alpha
    renderHeader({ activeOp });
    expect(screen.getByText("LEAD")).toBeInTheDocument();
    expect(screen.getByText("HEALTH")).toBeInTheDocument();
    expect(screen.getByText("TARGET")).toBeInTheDocument();
    expect(screen.getByText("Operation Alpha")).toBeInTheDocument();
  });

  it("op-meta DOSSIER link calls onOpenDossier on click", async () => {
    const activeOp = operations[0];
    const onOpenDossier = vi.fn();
    renderHeader({ activeOp, onOpenDossier });
    const dossierBtn = screen.getByText("tasks/ops-1");
    await userEvent.click(dossierBtn);
    expect(onOpenDossier).toHaveBeenCalledWith("tasks/ops-1");
  });

  it("op-meta HEALTH value shows the health text for AMBER op", () => {
    const amberOp = operations[1]; // health=AMBER
    renderHeader({ activeOp: amberOp });
    // The bold "AMBER" text should be visible in the op-meta line
    const amberEl = screen.getByText("AMBER");
    expect(amberEl.tagName).toBe("B");
    // Style attribute should contain the warn token
    expect(amberEl.getAttribute("style")).toContain("var(--warn)");
  });

  it("op-meta HEALTH value uses muted color for unknown health status", () => {
    const noneOp = { ...operations[0], health: "NONE" as const };
    renderHeader({ operations: [noneOp], activeOp: noneOp });
    const healthEl = screen.getByText("NONE") as HTMLElement;
    expect(healthEl.tagName).toBe("B");
    expect(healthEl.style.color).toBe("var(--ink-mute)");
  });

  // ── filter strip: shared FilterBar wiring ─────────────────────────────────

  it("renders the filter input with placeholder", () => {
    renderHeader();
    const input = screen.getByTestId("filter-bar-input");
    expect(input).toHaveAttribute("id", "tasking-filter");
    expect(input).toHaveAttribute("placeholder", "FILTER…");
  });

  it("typing into the filter input calls onFilterChange with the composed text state", () => {
    const onFilterChange = vi.fn();
    renderHeader({ onFilterChange });
    const input = screen.getByTestId("filter-bar-input");
    fireEvent.change(input, { target: { value: "alpha" } });
    expect(onFilterChange).toHaveBeenCalledWith({ text: "alpha", facets: {} });
  });

  it("Escape in the filter input clears text via onFilterChange and blurs", async () => {
    const onFilterChange = vi.fn();
    renderHeader({
      filterState: { text: "alpha", facets: {} },
      onFilterChange,
    });
    const input = screen.getByTestId("filter-bar-input") as HTMLInputElement;
    input.focus();
    expect(input).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(onFilterChange).toHaveBeenCalledWith({ text: "", facets: {} });
    expect(input).not.toHaveFocus();
  });

  it("selecting a facet option in the add-filter popover calls onFilterChange with the toggled facet", async () => {
    const onFilterChange = vi.fn();
    renderHeader({ onFilterChange });
    await userEvent.click(screen.getByTestId("filter-bar-add"));
    await userEvent.click(screen.getByTestId("filter-bar-field-pri"));
    await userEvent.click(screen.getByTestId("filter-bar-option-pri-P0"));
    expect(onFilterChange).toHaveBeenCalledWith({
      text: "",
      facets: { pri: ["P0"] },
    });
  });

  it("selecting the ON HOLD flag field calls onFilterChange with the flag facet", async () => {
    const onFilterChange = vi.fn();
    renderHeader({ onFilterChange });
    await userEvent.click(screen.getByTestId("filter-bar-add"));
    await userEvent.click(screen.getByTestId("filter-bar-field-hold"));
    expect(onFilterChange).toHaveBeenCalledWith({
      text: "",
      facets: { hold: [FLAG_ON] },
    });
  });

  it("does NOT render the N OF M count line when the filter is inactive", () => {
    renderHeader();
    expect(screen.queryByTestId("filter-bar-count")).not.toBeInTheDocument();
  });

  it("renders the N OF M count line, zero-padded, when the filter is active", () => {
    renderHeader({
      filterState: { text: "alpha", facets: {} },
      filteredCount: 1,
      opFilteredCount: 3,
    });
    expect(screen.getByTestId("filter-bar-count")).toHaveTextContent(
      "01 OF 03",
    );
  });
});

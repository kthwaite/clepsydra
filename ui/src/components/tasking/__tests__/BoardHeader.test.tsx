import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_FILTER } from "#/components/tasking/board-filter";
import { useBoardStore } from "#/store/board";
import { BoardHeader } from "../BoardHeader";
import { BOARD_FIXTURE } from "./fixtures";

const { operations, cycles, tasks } = BOARD_FIXTURE;

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
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
    filter: EMPTY_FILTER,
  });
});

describe("BoardHeader", () => {
  // ── title block ────────────────────────────────────────────────────────────

  it("renders TASKING BOARD heading", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    expect(
      screen.getByRole("heading", { name: /TASKING BOARD/i }),
    ).toBeInTheDocument();
  });

  it("renders OPS REGISTER label with correct counts", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    expect(screen.getByText(/2 OPERATIONS/)).toBeInTheDocument();
    expect(screen.getByText(/2 CYCLES/)).toBeInTheDocument();
  });

  // ── stat computation ───────────────────────────────────────────────────────

  it("computes OPEN count (non-SEALED tasks)", () => {
    // tasks has 4 non-SEALED (t1 FIELD, t2 INTAKE, t3 TRIAGE, t4 INTAKE) + 1 SEALED (t5)
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    // "04" = 4 open tasks
    const openLabel = screen.getByText("OPEN");
    const openStat = openLabel.parentElement!.querySelector("span:last-child");
    expect(openStat?.textContent).toBe("04");
  });

  it("computes IN-FIELD count zero-padded", () => {
    // t1 has status=FIELD
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const fieldLabel = screen.getByText("IN-FIELD");
    const fieldStat =
      fieldLabel.parentElement!.querySelector("span:last-child");
    expect(fieldStat?.textContent).toBe("01");
  });

  it("computes ON HOLD count zero-padded", () => {
    // t2 has hold='blocker'
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const holdLabel = screen.getByText("ON HOLD");
    const holdStat = holdLabel.parentElement!.querySelector("span:last-child");
    expect(holdStat?.textContent).toBe("01");
  });

  it("ON HOLD stat uses hot color when count > 0", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const holdLabel = screen.getByText("ON HOLD");
    const holdStat = holdLabel.parentElement!.querySelector(
      "span:last-child",
    ) as HTMLElement;
    expect(holdStat?.style.color).toBe("var(--hot)");
  });

  it("ON HOLD stat uses ink color when count is 0", () => {
    const noHoldTasks = tasks.filter((t) => !t.hold);
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={noHoldTasks}
        activeOp={null}
        filteredCount={noHoldTasks.length}
        opFilteredCount={noHoldTasks.length}
      />,
    );
    const holdLabel = screen.getByText("ON HOLD");
    const holdStat = holdLabel.parentElement!.querySelector(
      "span:last-child",
    ) as HTMLElement;
    expect(holdStat?.style.color).toBe("var(--ink)");
  });

  it("renders SEAL RATE 14d sparkline", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        sealHistory={[0, 1, 2]}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    expect(screen.getByText("SEAL RATE 14d")).toBeInTheDocument();
    // SVG polyline is present
    expect(document.querySelector("polyline")).toBeInTheDocument();
  });

  // ── mode toggles ───────────────────────────────────────────────────────────

  it("renders all 4 mode buttons", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    expect(screen.getByRole("tab", { name: /CARD/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /BACKLOG/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /CYCLE/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /TIMELINE/ })).toBeInTheDocument();
  });

  it("clicking a mode button updates store mode", async () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const backlogBtn = screen.getByRole("tab", { name: /BACKLOG/ });
    await userEvent.click(backlogBtn);
    expect(useBoardStore.getState().mode).toBe("backlog");
  });

  it("active mode tab has aria-selected=true", () => {
    useBoardStore.setState({ mode: "backlog" });
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const backlogBtn = screen.getByRole("tab", { name: /BACKLOG/ });
    expect(backlogBtn).toHaveAttribute("aria-selected", "true");
  });

  // ── op-meta line ───────────────────────────────────────────────────────────

  it("does NOT render op-meta line when activeOp is null", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    expect(screen.queryByText("LEAD")).not.toBeInTheDocument();
    expect(screen.queryByText("HEALTH")).not.toBeInTheDocument();
  });

  it("renders op-meta line when activeOp is set", () => {
    const activeOp = operations[0]; // Operation Alpha
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={activeOp}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    expect(screen.getByText("LEAD")).toBeInTheDocument();
    expect(screen.getByText("HEALTH")).toBeInTheDocument();
    expect(screen.getByText("TARGET")).toBeInTheDocument();
    expect(screen.getByText("Operation Alpha")).toBeInTheDocument();
  });

  it("op-meta DOSSIER link calls onOpenDossier on click", async () => {
    const activeOp = operations[0];
    const onOpenDossier = vi.fn();
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={activeOp}
        onOpenDossier={onOpenDossier}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const dossierBtn = screen.getByText("tasks/ops-1");
    await userEvent.click(dossierBtn);
    expect(onOpenDossier).toHaveBeenCalledWith("tasks/ops-1");
  });

  it("op-meta HEALTH value shows the health text for AMBER op", () => {
    const amberOp = operations[1]; // health=AMBER
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={amberOp}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    // The bold "AMBER" text should be visible in the op-meta line
    const amberEl = screen.getByText("AMBER");
    expect(amberEl.tagName).toBe("B");
    // Style attribute should contain the warn token
    expect(amberEl.getAttribute("style")).toContain("var(--warn)");
  });

  it("op-meta HEALTH value uses muted color for unknown health status", () => {
    const noneOp = { ...operations[0], health: "NONE" as const };
    wrap(
      <BoardHeader
        operations={[noneOp]}
        cycles={cycles}
        tasks={tasks}
        activeOp={noneOp}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const healthEl = screen.getByText("NONE") as HTMLElement;
    expect(healthEl.tagName).toBe("B");
    expect(healthEl.style.color).toBe("var(--ink-mute)");
  });

  // ── filter strip ───────────────────────────────────────────────────────────

  it("renders the filter input with placeholder", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const input = screen.getByTestId("board-filter-input");
    expect(input).toHaveAttribute("id", "tasking-filter");
    expect(input).toHaveAttribute("placeholder", "FILTER…");
  });

  it("typing into the filter input updates the store", async () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const input = screen.getByTestId("board-filter-input");
    await userEvent.type(input, "alpha");
    expect(useBoardStore.getState().filter.text).toBe("alpha");
  });

  it("Escape in the filter input clears text and blurs", async () => {
    useBoardStore.setState({
      filter: { text: "alpha", pris: [], holdOnly: false },
    });
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const input = screen.getByTestId("board-filter-input") as HTMLInputElement;
    input.focus();
    expect(input).toHaveFocus();
    await userEvent.keyboard("{Escape}");
    expect(useBoardStore.getState().filter.text).toBe("");
    expect(input).not.toHaveFocus();
  });

  it("renders a toggle button for each PRI_ORDER entry, aria-pressed off by default", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    for (const p of ["P0", "P1", "P2", "P3"]) {
      const btn = screen.getByTestId(`board-filter-pri-${p}`);
      expect(btn).toHaveAttribute("aria-pressed", "false");
    }
  });

  it("clicking a priority toggle flips aria-pressed and updates the store", async () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const p0Btn = screen.getByTestId("board-filter-pri-P0");
    await userEvent.click(p0Btn);
    expect(p0Btn).toHaveAttribute("aria-pressed", "true");
    expect(useBoardStore.getState().filter.pris).toEqual(["P0"]);

    await userEvent.click(p0Btn);
    expect(p0Btn).toHaveAttribute("aria-pressed", "false");
    expect(useBoardStore.getState().filter.pris).toEqual([]);
  });

  it("clicking the HOLD toggle flips aria-pressed and updates the store", async () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    const holdBtn = screen.getByTestId("board-filter-hold");
    expect(holdBtn).toHaveAttribute("aria-pressed", "false");
    await userEvent.click(holdBtn);
    expect(holdBtn).toHaveAttribute("aria-pressed", "true");
    expect(useBoardStore.getState().filter.holdOnly).toBe(true);
  });

  it("does NOT render the N OF M count line when the filter is inactive", () => {
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={tasks.length}
        opFilteredCount={tasks.length}
      />,
    );
    expect(screen.queryByTestId("board-filter-count")).not.toBeInTheDocument();
  });

  it("renders the N OF M count line, zero-padded, when the filter is active", () => {
    useBoardStore.setState({
      filter: { text: "alpha", pris: [], holdOnly: false },
    });
    wrap(
      <BoardHeader
        operations={operations}
        cycles={cycles}
        tasks={tasks}
        activeOp={null}
        filteredCount={1}
        opFilteredCount={3}
      />,
    );
    expect(screen.getByTestId("board-filter-count")).toHaveTextContent(
      "01 OF 03",
    );
  });
});

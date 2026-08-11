import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
      />,
    );
    const healthEl = screen.getByText("NONE") as HTMLElement;
    expect(healthEl.tagName).toBe("B");
    expect(healthEl.style.color).toBe("var(--ink-mute)");
  });
});

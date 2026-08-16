/**
 * KanbanView column resize — store clamping + resize-handle interactions.
 *
 * See KanbanView.test.tsx for the broader render harness this reuses.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useBoardStore } from "#/store/board";
import { KanbanView } from "../KanbanView";
import { BOARD_FIXTURE, FIXTURE_COL_LABEL } from "./fixtures";

const { columns, tasks, cycles } = BOARD_FIXTURE;

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function renderKanban() {
  return wrap(
    <KanbanView
      colLabel={FIXTURE_COL_LABEL}
      columns={columns}
      tasks={tasks}
      cycles={cycles}
      showOp={false}
    />,
  );
}

beforeEach(() => {
  useBoardStore.setState({ columnWidths: {} });
});

// ══════════════════════════════════════════════════════════════════════════════
// store-level clamping
// ══════════════════════════════════════════════════════════════════════════════

describe("useBoardStore — column widths", () => {
  it("clamps column widths to [220, 640]", () => {
    useBoardStore.getState().setColumnWidth("FIELD", 100);
    expect(useBoardStore.getState().columnWidths.FIELD).toBe(220);

    useBoardStore.getState().setColumnWidth("FIELD", 9000);
    expect(useBoardStore.getState().columnWidths.FIELD).toBe(640);

    useBoardStore.getState().resetColumnWidth("FIELD");
    expect(useBoardStore.getState().columnWidths.FIELD).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// KanbanView — resize handle
// ══════════════════════════════════════════════════════════════════════════════

describe("KanbanView — column resize", () => {
  it("applies a stored width to the column", () => {
    useBoardStore.getState().setColumnWidth("INTAKE", 400);
    renderKanban();

    const col = screen.getByTestId("kb-col-INTAKE");
    expect(col).toHaveStyle({ flex: "0 0 400px" });
  });

  it("each column exposes a resize separator", () => {
    renderKanban();

    const separators = screen.getAllByRole("separator", {
      name: /resize .* column/i,
    });
    expect(separators).toHaveLength(columns.length);
    for (const separator of separators) {
      expect(separator).toHaveAttribute("aria-orientation", "vertical");
      expect(separator).toHaveAttribute("aria-valuemin", "220");
      expect(separator).toHaveAttribute("aria-valuemax", "640");
    }
  });

  it("keyboard resize adjusts width by 16px per arrow key and double-click resets", () => {
    renderKanban();

    const separator = screen.getByRole("separator", {
      name: /resize intake column/i,
    });
    separator.focus();

    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(useBoardStore.getState().columnWidths.INTAKE).toBe(298);

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    expect(useBoardStore.getState().columnWidths.INTAKE).toBe(266);

    fireEvent.doubleClick(separator);
    expect(useBoardStore.getState().columnWidths.INTAKE).toBeUndefined();
  });
});

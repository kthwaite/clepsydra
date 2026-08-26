import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  COL_LABEL,
  COL_SUBLABEL,
  cycleStateLabel,
  fmtCycleWindow,
  MODES,
  PRI_LABEL,
  PRI_ORDER,
} from "../board-constants";
import { DispositionRow, PriorityRow } from "../fields";

describe("Task Board display vocabulary", () => {
  it("uses neutral priority descriptions without changing priority ids", () => {
    expect(PRI_ORDER.map((id) => [id, PRI_LABEL[id]])).toEqual([
      ["P0", "Critical"],
      ["P1", "High"],
      ["P2", "Medium"],
      ["P3", "Low"],
    ]);
  });

  it("uses neutral mode labels without changing persisted mode ids", () => {
    expect(MODES.map(({ id, label }) => [id, label])).toEqual([
      ["card", "Board"],
      ["backlog", "List"],
      ["cycle", "Cycles"],
      ["timeline", "Timeline"],
    ]);
  });

  it("uses neutral column sublabels without changing status ids", () => {
    expect(
      ["INTAKE", "TRIAGE", "FIELD", "REVIEW", "SEALED"].map((id) => [
        id,
        COL_SUBLABEL[id],
      ]),
    ).toEqual([
      ["INTAKE", "Unassessed"],
      ["TRIAGE", "Ready to start"],
      ["FIELD", "Being worked on"],
      ["REVIEW", "Awaiting review"],
      ["SEALED", "Completed"],
    ]);
  });

  it("renders neutral status labels while preserving raw radio values", async () => {
    const onChange = vi.fn();
    render(
      <DispositionRow
        value="INTAKE"
        onChange={onChange}
        testIdPrefix="vocabulary"
        colLabel={(id) => COL_LABEL[id] ?? id}
      />,
    );

    const status = screen.getByRole("radiogroup", { name: "Status" });
    for (const label of ["Inbox", "Ready", "In Progress", "Review", "Done"]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("radio", { name: "In Progress" }));
    expect(onChange).toHaveBeenCalledWith("FIELD");
    expect(status).toBeInTheDocument();
  });

  it("renders approved priority labels while preserving raw radio values", async () => {
    const onChange = vi.fn();
    render(
      <PriorityRow
        value="P2"
        onChange={onChange}
        testIdPrefix="vocabulary"
      />,
    );

    for (const label of [
      "P0 Critical",
      "P1 High",
      "P2 Medium",
      "P3 Low",
    ]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("radio", { name: "P0 Critical" }));
    expect(onChange).toHaveBeenCalledWith("P0");
  });


  it("uses neutral copy for an undated Cycle window", () => {
    expect(fmtCycleWindow(null, null)).toBe("No dates");
  });
  it("maps cycle state ids to display labels and falls back to the raw id", () => {
    expect(
      ["PLANNED", "ACTIVE", "CLOSED", "BACKLOG", "PAUSED"].map((state) => [
        state,
        cycleStateLabel(state),
      ]),
    ).toEqual([
      ["PLANNED", "Planned"],
      ["ACTIVE", "Active"],
      ["CLOSED", "Closed"],
      ["BACKLOG", "Backlog"],
      ["PAUSED", "PAUSED"],
    ]);
  });
});

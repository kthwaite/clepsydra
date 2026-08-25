import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MODES, PRI_LABEL, PRI_ORDER } from "../board-constants";
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

  it("exposes task status and priority radio groups by neutral names", () => {
    const { rerender } = render(
      <DispositionRow
        value="INTAKE"
        onChange={vi.fn()}
        testIdPrefix="vocabulary"
        colLabel={(id) => id}
      />,
    );

    expect(
      screen.getByRole("radiogroup", { name: "Status" }),
    ).toBeInTheDocument();

    rerender(
      <PriorityRow
        value="P2"
        onChange={vi.fn()}
        testIdPrefix="vocabulary"
      />,
    );

    expect(
      screen.getByRole("radiogroup", { name: "Priority" }),
    ).toBeInTheDocument();
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  COL_LABEL,
  COL_SUBLABEL,
  cycleStateLabel,
  fmtCycleWindow,
  healthColor,
  MODES,
  PRI_LABEL,
  PRI_ORDER,
  priColor,
  TYPE_LABEL,
  TYPE_NONE,
  TYPE_ORDER,
  taskStatusLabel,
} from "../board-constants";
import { DispositionRow, PRI_ON_STYLE, PriorityRow, TypeRow } from "../fields";

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
      <PriorityRow value="P2" onChange={onChange} testIdPrefix="vocabulary" />,
    );

    for (const label of ["P0 Critical", "P1 High", "P2 Medium", "P3 Low"]) {
      expect(screen.getByRole("radio", { name: label })).toBeInTheDocument();
    }

    await userEvent.click(screen.getByRole("radio", { name: "P0 Critical" }));
    expect(onChange).toHaveBeenCalledWith("P0");
  });

  it("formats a Cycle window as day and short month", () => {
    expect(fmtCycleWindow("2026-09-21", "2026-10-04")).toBe("21 Sep – 4 Oct");
    expect(fmtCycleWindow("2026-09-14", "2026-09-27")).toBe("14–27 Sep");
    expect(fmtCycleWindow("2026-09-14", null)).toBe("From 14 Sep");
    expect(fmtCycleWindow(null, "2026-09-27")).toBe("Until 27 Sep");
  });

  it("uses neutral copy for an undated Cycle window", () => {
    expect(fmtCycleWindow(null, null)).toBe("No dates");
  });
  it("maps Task status ids to display labels and falls back to the raw id", () => {
    expect(taskStatusLabel("INTAKE")).toBe("Inbox");
    expect(taskStatusLabel("FIELD")).toBe("In Progress");
    expect(taskStatusLabel("UNKNOWN")).toBe("UNKNOWN");
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

describe("priority tones stay legible", () => {
  it("draws Low's label in mute (faint only for its bar)", () => {
    expect(priColor("P3")).toEqual({
      bar: "var(--faint)",
      text: "var(--mute)",
    });
  });

  it("puts ground text on the Critical, High and Medium fills; ink only on Low", () => {
    expect(PRI_ON_STYLE.P0.color).toBe("var(--ground)");
    expect(PRI_ON_STYLE.P1.color).toBe("var(--ground)");
    expect(PRI_ON_STYLE.P2.color).toBe("var(--ground)");
    expect(PRI_ON_STYLE.P3.color).toBe("var(--ink)");
  });
});

describe("healthColor", () => {
  it("maps health to Stone & Lamp tokens, cobalt for green", () => {
    expect(healthColor("GREEN")).toBe("var(--accent)");
    expect(healthColor("AMBER")).toBe("var(--warn)");
    expect(healthColor("RED")).toBe("var(--hot)");
    expect(healthColor("")).toBe("var(--mute)");
  });
});

describe("task type vocabulary", () => {
  it("orders the five types with sentence-case labels", () => {
    expect(TYPE_ORDER.map((id) => [id, TYPE_LABEL[id]])).toEqual([
      ["FEATURE", "Feature"],
      ["FIX", "Fix"],
      ["TASK", "Task"],
      ["STORY", "Story"],
      ["SPIKE", "Spike"],
    ]);
    expect(TYPE_NONE).toBe("UNTYPED");
  });
});

describe("TypeRow", () => {
  it("offers None first, then the five types", () => {
    render(<TypeRow value={null} onChange={vi.fn()} testIdPrefix="t" />);
    const group = screen.getByRole("radiogroup", { name: "Type" });
    const names = Array.from(group.querySelectorAll("label")).map((l) =>
      l.textContent?.trim(),
    );
    expect(names).toEqual(["None", "Feature", "Fix", "Task", "Story", "Spike"]);
    expect(screen.getByRole("radio", { name: "None" })).toBeChecked();
  });

  it("calls onChange with the type id, and null for None", async () => {
    const onChange = vi.fn();
    render(<TypeRow value="FIX" onChange={onChange} testIdPrefix="t" />);
    expect(screen.getByRole("radio", { name: "Fix" })).toBeChecked();

    await userEvent.click(screen.getByRole("radio", { name: "Spike" }));
    expect(onChange).toHaveBeenLastCalledWith("SPIKE");

    await userEvent.click(screen.getByRole("radio", { name: "None" }));
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});

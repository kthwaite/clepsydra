import { describe, expect, it } from "vitest";
import {
  COL_ORDER,
  DEFAULT_PRIORITY,
  DEFAULT_STATUS,
  isDone,
  isInProgress,
  statusLook,
} from "../board-constants";

describe("Task Field vocabulary", () => {
  it("defaults match the server's board vocabulary", () => {
    expect(DEFAULT_STATUS).toBe("INTAKE");
    expect(DEFAULT_PRIORITY).toBe("P2");
  });

  it("isDone is true only for SEALED", () => {
    expect(COL_ORDER.filter(isDone)).toEqual(["SEALED"]);
    expect(isDone("sealed")).toBe(false);
  });

  it("isInProgress is true only for FIELD", () => {
    expect(COL_ORDER.filter(isInProgress)).toEqual(["FIELD"]);
  });

  it("statusLook gives each column its colour, label and faintness", () => {
    expect(COL_ORDER.map((s) => [s, statusLook(s)])).toEqual([
      ["INTAKE", { color: "var(--faint)", label: "Inbox", faint: true }],
      ["TRIAGE", { color: "var(--ink-2)", label: "Ready", faint: false }],
      ["FIELD", { color: "var(--accent)", label: "In Progress", faint: false }],
      ["REVIEW", { color: "var(--hot)", label: "Review", faint: false }],
      ["SEALED", { color: "var(--faint)", label: "Done", faint: true }],
    ]);
  });

  it("statusLook falls back for an unknown status", () => {
    expect(statusLook("PARKED")).toEqual({
      color: "var(--faint)",
      label: "PARKED",
      faint: false,
    });
  });
});

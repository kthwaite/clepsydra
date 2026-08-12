import { describe, it, expect } from "vitest";
import type { BoardTask } from "#/api/board";
import {
  EMPTY_FILTER,
  isFilterActive,
  applyBoardFilter,
  type BoardFilter,
} from "../board-filter";

const mockTask = (overrides?: Partial<BoardTask>): BoardTask => ({
  id: "task-1",
  path: "tasks/task-1",
  title: "Fix auth bug",
  code: "T-42",
  status: "in_progress",
  priority: "P1",
  project: "platform",
  cycle: "Q3",
  assignee: "alice",
  estimate: "3",
  due: "2026-08-20",
  start: "2026-08-10",
  hold: null,
  link: null,
  tags: ["bug", "critical"],
  checks: [],
  updated_at: "2026-08-12T00:00:00Z",
  ...overrides,
});

describe("BoardFilter", () => {
  describe("isFilterActive", () => {
    it("returns false for EMPTY_FILTER", () => {
      expect(isFilterActive(EMPTY_FILTER)).toBe(false);
    });

    it("returns true when text is non-empty", () => {
      const filter: BoardFilter = { text: "foo", pris: [], holdOnly: false };
      expect(isFilterActive(filter)).toBe(true);
    });

    it("returns true when pris array is non-empty", () => {
      const filter: BoardFilter = { text: "", pris: ["P0"], holdOnly: false };
      expect(isFilterActive(filter)).toBe(true);
    });

    it("returns true when holdOnly is true", () => {
      const filter: BoardFilter = { text: "", pris: [], holdOnly: true };
      expect(isFilterActive(filter)).toBe(true);
    });

    it("ignores whitespace-only text", () => {
      const filter: BoardFilter = {
        text: "   ",
        pris: [],
        holdOnly: false,
      };
      expect(isFilterActive(filter)).toBe(false);
    });
  });

  describe("applyBoardFilter", () => {
    const tasks = [
      mockTask({
        id: "1",
        title: "Fix login",
        code: "T-1",
        tags: ["bug"],
        assignee: "alice",
      }),
      mockTask({
        id: "2",
        title: "Add feature",
        code: "T-2",
        priority: "P0",
        tags: ["feature"],
      }),
      mockTask({
        id: "3",
        title: "Refactor",
        code: "T-3",
        priority: "P2",
        assignee: "bob",
        hold: "blocked",
        tags: [],
      }),
    ];

    it("returns the same reference when filter is inactive", () => {
      const result = applyBoardFilter(tasks, EMPTY_FILTER);
      expect(result).toBe(tasks);
    });

    describe("text search", () => {
      it("matches case-insensitively on title", () => {
        const filter: BoardFilter = {
          text: "FIX",
          pris: [],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("1");
      });

      it("matches on code", () => {
        const filter: BoardFilter = {
          text: "T-2",
          pris: [],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("2");
      });

      it("matches on tags", () => {
        const filter: BoardFilter = {
          text: "bug",
          pris: [],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("1");
      });

      it("matches on assignee", () => {
        const filter: BoardFilter = {
          text: "bob",
          pris: [],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("3");
      });

      it("does not match on status, project, cycle, or other fields", () => {
        const filter: BoardFilter = {
          text: "in_progress",
          pris: [],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(0);
      });

      it("matches multiple tasks on same query", () => {
        const filter: BoardFilter = {
          text: "a",
          pris: [],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        // "a" appears in "Feature" (id:2), "Refactor" (id:3), "alice" (id:1)
        expect(result).toHaveLength(3);
      });

      it("handles whitespace trimming", () => {
        const filter: BoardFilter = {
          text: "  FIX  ",
          pris: [],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("1");
      });
    });

    describe("priority filter", () => {
      it("keeps only tasks with specified priorities", () => {
        const filter: BoardFilter = {
          text: "",
          pris: ["P0"],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("2");
      });

      it("supports multiple priorities", () => {
        const filter: BoardFilter = {
          text: "",
          pris: ["P0", "P1"],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(2);
        expect(result.map((t) => t.id)).toEqual(["1", "2"]);
      });

      it("returns empty array when no tasks match priority", () => {
        const filter: BoardFilter = {
          text: "",
          pris: ["P99"],
          holdOnly: false,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(0);
      });
    });

    describe("holdOnly filter", () => {
      it("keeps only tasks where hold is truthy", () => {
        const filter: BoardFilter = {
          text: "",
          pris: [],
          holdOnly: true,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("3");
      });
    });

    describe("composition", () => {
      it("combines text, priority, and holdOnly filters", () => {
        const tasksWithHold = [
          mockTask({
            id: "1",
            title: "Fix critical",
            priority: "P0",
            hold: "blocked",
          }),
          mockTask({
            id: "2",
            title: "Fix minor",
            priority: "P2",
            hold: "waiting",
          }),
          mockTask({
            id: "3",
            title: "Feature",
            priority: "P0",
            hold: null,
          }),
        ];

        const filter: BoardFilter = {
          text: "fix",
          pris: ["P0"],
          holdOnly: true,
        };
        const result = applyBoardFilter(tasksWithHold, filter);
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe("1");
      });

      it("returns empty when all conditions fail", () => {
        const filter: BoardFilter = {
          text: "nonexistent",
          pris: ["P2"],
          holdOnly: true,
        };
        const result = applyBoardFilter(tasks, filter);
        expect(result).toHaveLength(0);
      });
    });
  });
});

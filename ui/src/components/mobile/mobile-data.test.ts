import { describe, expect, it } from "vitest";
import type { BoardTask } from "#/api/board";
import type { AgendaResponse, AgendaTask, AgendaTodo } from "#/api/tasks";
import {
  agendaItemKey,
  agendaItemPath,
  agendaItemTitle,
  bucketAgenda,
  journalExcerpt,
  tasksByStatus,
} from "#/components/mobile/mobile-data";

const todo = (content: string, span = 1): AgendaTodo => ({
  kind: "todo",
  content,
  page_path: "notes/a.md",
  page_title: "A",
  properties: {},
  span_start: span,
  span_end: span + 5,
  status: "todo",
});
const task = (title: string): AgendaTask => ({
  kind: "task",
  id: "00000000-0000-0000-0000-000000000001",
  code: "TSK-brave-finch",
  title,
  path: "tasks/t.md",
  due: "2026-09-25",
  priority: "P1",
  status: "TRIAGE",
});

describe("journalExcerpt", () => {
  it("takes the first prose paragraph, stripped of markup", () => {
    const body = [
      "---",
      "kind: journal",
      "---",
      "# Friday",
      "",
      "- Finished **the chapter** on [[people/ctesibius|Ctesibius]]; see [notes](x.md) and [[Vitruvius]].",
      "",
      "Second paragraph.",
    ].join("\n");
    expect(journalExcerpt(body)).toBe(
      "Finished the chapter on Ctesibius; see notes and Vitruvius.",
    );
  });

  it("cuts long text on a word boundary", () => {
    const out = journalExcerpt(`${"word ".repeat(60)}end`, 30);
    expect(out).toBe("word word word word word word…");
  });

  it("returns null when there is no prose", () => {
    expect(journalExcerpt("")).toBeNull();
    expect(journalExcerpt("---\na: b\n---\n# Only a heading\n")).toBeNull();
  });
});

describe("bucketAgenda", () => {
  const data: AgendaResponse = {
    overdue: [todo("late")],
    today: [task("now")],
    upcoming: [
      { date: "2026-10-02", items: [todo("in seven", 2)] },
      { date: "2026-10-03", items: [todo("in eight", 3)] },
    ],
    undated: [todo("whenever", 4)],
  };

  it("orders buckets; everything upcoming is this week (the server sends seven days)", () => {
    const buckets = bucketAgenda(data);
    expect(buckets.map((b) => [b.label, b.items.map(agendaItemTitle)])).toEqual(
      [
        ["Overdue", ["late"]],
        ["Today", ["now"]],
        ["This week", ["in seven", "in eight"]],
        ["No date", ["whenever"]],
      ],
    );
  });

  it("omits empty buckets", () => {
    const buckets = bucketAgenda({
      overdue: [],
      today: [task("now")],
      upcoming: [],
      undated: [],
    });
    expect(buckets.map((b) => b.key)).toEqual(["today"]);
  });
});

describe("agenda item accessors", () => {
  it("reads todos and tasks alike", () => {
    expect(agendaItemPath(todo("x"))).toBe("notes/a.md");
    expect(agendaItemPath(task("y"))).toBe("tasks/t.md");
    expect(agendaItemKey(todo("x", 7))).toBe("todo:notes/a.md:7");
    expect(agendaItemKey(task("y"))).toBe(
      "task:00000000-0000-0000-0000-000000000001",
    );
  });
});

describe("tasksByStatus", () => {
  const t = (id: string, status: string, updated_at = "2026-09-01T00:00:00Z") =>
    ({ id, status, updated_at }) as BoardTask;

  it("groups by status in board order and caps Done at the 20 newest", () => {
    const sealed = Array.from({ length: 25 }, (_, i) =>
      t(
        `s${i}`,
        "SEALED",
        `2026-09-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
      ),
    );
    const groups = tasksByStatus([
      t("a", "TRIAGE"),
      t("b", "INTAKE"),
      ...sealed,
    ]);
    expect(groups.TRIAGE.map((x) => x.id)).toEqual(["a"]);
    expect(groups.INTAKE.map((x) => x.id)).toEqual(["b"]);
    expect(groups.FIELD).toEqual([]);
    expect(groups.SEALED).toHaveLength(20);
    expect(groups.SEALED[0].id).toBe("s24");
  });
});

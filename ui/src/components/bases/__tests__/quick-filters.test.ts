import { describe, expect, it } from "vitest";
import {
  DATE_PRESETS,
  datePresetFilter,
  HEADER_OPTION_CAP,
  headerFilterPresets,
  isDateLike,
  quickFiltersForCell,
  quickFilterType,
} from "#/components/bases/quick-filters";

describe("quickFilterType", () => {
  it("uses the declared type and maps system columns", () => {
    expect(quickFilterType("status", { type: "select" })).toBe("select");
    expect(quickFilterType("kind", undefined)).toBe("system-scalar");
    expect(quickFilterType("project", undefined)).toBe("system-scalar");
    expect(quickFilterType("tags", undefined)).toBe("system-multi");
    expect(quickFilterType("created_at", undefined)).toBe("datetime");
    expect(quickFilterType("journal_date", undefined)).toBe("date");
    for (const column of [
      "title",
      "path",
      "id",
      "body",
      "word_count",
      "unknown",
    ]) {
      expect(quickFilterType(column, undefined)).toBeUndefined();
    }
  });
});

describe("quickFiltersForCell", () => {
  it("offers is-empty for empty values of any filterable type", () => {
    expect(quickFiltersForCell("status", "select", null, "Status")).toEqual([
      { field: "status", op: "is_empty", label: "Status is empty" },
    ]);
    expect(quickFiltersForCell("tags", "system-multi", [], "Tags")).toEqual([
      { field: "tags", op: "is_empty", label: "Tags is empty" },
    ]);
  });

  it("derives equality for scalars, quoting text", () => {
    expect(
      quickFiltersForCell("status", "select", "reading", "Status"),
    ).toEqual([
      {
        field: "status",
        op: "eq",
        value: "reading",
        label: "Status is reading",
      },
    ]);
    expect(quickFiltersForCell("rating", "number", 4, "Rating")).toEqual([
      { field: "rating", op: "eq", value: 4, label: "Rating is 4" },
    ]);
    expect(quickFiltersForCell("author", "text", "Wolfe", "Author")).toEqual([
      { field: "author", op: "eq", value: "Wolfe", label: 'Author is "Wolfe"' },
    ]);
    expect(
      quickFiltersForCell("kind", "system-scalar", "BOOK", "Kind"),
    ).toEqual([
      { field: "kind", op: "eq", value: "BOOK", label: "Kind is BOOK" },
    ]);
  });

  it("derives checked and unchecked for booleans", () => {
    expect(quickFiltersForCell("done", "bool", true, "Done")).toEqual([
      { field: "done", op: "eq", value: true, label: "Done is checked" },
    ]);
    expect(quickFiltersForCell("done", "bool", false, "Done")).toEqual([
      { field: "done", op: "eq", value: false, label: "Done is unchecked" },
    ]);
  });

  it("derives one membership filter per element", () => {
    expect(
      quickFiltersForCell("themes", "multi_select", ["a", "b"], "Themes"),
    ).toEqual([
      { field: "themes", op: "contains", value: "a", label: "Themes has a" },
      { field: "themes", op: "contains", value: "b", label: "Themes has b" },
    ]);
    expect(
      quickFiltersForCell("series", "relation", ["[[Earthsea]]"], "Series"),
    ).toEqual([
      {
        field: "series",
        op: "links_to",
        value: "[[Earthsea]]",
        label: "Series links to [[Earthsea]]",
      },
    ]);
  });

  it("uses the date face for dates and nothing for datetimes", () => {
    expect(quickFiltersForCell("due", "date", "2026-08-28", "Due")).toEqual([
      {
        field: "due",
        op: "eq",
        value: "2026-08-28",
        label: "Due is 2026-08-28",
      },
    ]);
    expect(
      quickFiltersForCell(
        "created_at",
        "datetime",
        "2026-08-28T10:00:00Z",
        "Created at",
      ),
    ).toEqual([]);
  });
});

describe("date presets", () => {
  it("lists the five relative operators", () => {
    expect(DATE_PRESETS.map((p) => p.op)).toEqual([
      "is_today",
      "is_this_week",
      "is_past_week",
      "is_next_week",
      "is_this_month",
    ]);
    expect(DATE_PRESETS.map((p) => p.label)).toEqual([
      "Today",
      "This week",
      "Past week",
      "Next week",
      "This month",
    ]);
    expect(isDateLike("date")).toBe(true);
    expect(isDateLike("datetime")).toBe(true);
    expect(isDateLike("text")).toBe(false);
    expect(datePresetFilter("due", "Due", "is_past_week")).toEqual({
      field: "due",
      op: "is_past_week",
      label: "Due is in the past week",
    });
  });
});

describe("headerFilterPresets", () => {
  it("offers emptiness for filterable columns and nothing for numbers", () => {
    expect(
      headerFilterPresets("author", "text", undefined, "Author").map(
        (f) => f.label,
      ),
    ).toEqual(["Author is empty", "Author is not empty"]);
    expect(
      headerFilterPresets("rating", "number", undefined, "Rating"),
    ).toEqual([]);
  });

  it("adds checked/unchecked, date presets and select options", () => {
    expect(
      headerFilterPresets("done", "bool", undefined, "Done").map(
        (f) => f.label,
      ),
    ).toEqual([
      "Done is checked",
      "Done is unchecked",
      "Done is empty",
      "Done is not empty",
    ]);
    expect(
      headerFilterPresets("due", "date", undefined, "Due").map((f) => f.label),
    ).toEqual([
      "Due is today",
      "Due is this week",
      "Due is in the past week",
      "Due is in the next week",
      "Due is this month",
      "Due is empty",
      "Due is not empty",
    ]);
    expect(
      headerFilterPresets(
        "status",
        "select",
        { type: "select", options: ["queued", "reading"] },
        "Status",
      ).map((f) => f.label),
    ).toEqual([
      "Status is queued",
      "Status is reading",
      "Status is empty",
      "Status is not empty",
    ]);
    expect(
      headerFilterPresets(
        "themes",
        "multi_select",
        { type: "multi_select", options: ["a"] },
        "Themes",
      ).map((f) => f.label),
    ).toEqual(["Themes has a", "Themes is empty", "Themes is not empty"]);
  });

  it("caps the option list", () => {
    const options = Array.from(
      { length: HEADER_OPTION_CAP + 3 },
      (_, i) => `o${i}`,
    );
    const presets = headerFilterPresets(
      "status",
      "select",
      { type: "select", options },
      "Status",
    );
    expect(presets.filter((f) => f.op === "eq")).toHaveLength(
      HEADER_OPTION_CAP,
    );
  });
});

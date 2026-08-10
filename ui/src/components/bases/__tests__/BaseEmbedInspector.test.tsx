import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseDetailResponse, BaseFilter } from "#/api/bases";
import { BaseEmbedInspector } from "#/components/bases/BaseEmbedInspector";
import {
  extractBaseEmbedTomlBody,
  validateBaseEmbedConfig,
} from "#/editor/convert/baseEmbedMarkdown";
import type {
  BaseEmbedElement,
  ConfiguredBaseEmbedElement,
  InvalidBaseEmbedElement,
} from "#/editor/schema/types";

const apiState = vi.hoisted(() => ({
  bases: {} as {
    data?: {
      bases: Array<{
        slug: string;
        name: string;
        description?: string | null;
        diagnostic_count: number;
        match_count?: number | null;
        views: string[];
      }>;
      diagnostics: never[];
    };
    isPending: boolean;
    isFetching: boolean;
    error: unknown;
  },
  details: {} as Record<
    string,
    {
      data?: BaseDetailResponse;
      isPending: boolean;
      isFetching: boolean;
      error: unknown;
    }
  >,
}));

vi.mock("#/api/bases", () => ({
  useBases: () => apiState.bases,
  useBase: (slug: string) =>
    apiState.details[slug] ?? {
      data: undefined,
      isPending: false,
      isFetching: false,
      error: new Error("missing"),
    },
}));

function detail(
  slug: string,
  name: string,
  views: string[],
  properties: BaseDetailResponse["properties"] = {},
): BaseDetailResponse {
  return {
    slug,
    name,
    properties,
    views: views.map((view) => ({
      name: view,
      layout: "table",
      columns: ["title"],
      sort: [],
    })),
    diagnostics: [],
    member_creation: [],
    revision: `${slug}-revision`,
  };
}

const reading = detail("reading", "Reading Log", ["All", "Unread"], {
  rating: { type: "number" },
  shelf: { type: "select", options: ["Now", "Later"] },
});
const tasks = detail("tasks", "Tasks", ["Open", "Closed"], {
  priority: { type: "number" },
});

function configured(
  overrides: Partial<ConfiguredBaseEmbedElement> = {},
): ConfiguredBaseEmbedElement {
  return {
    type: "base-embed",
    status: "configured",
    base: "reading",
    view: "All",
    limit: 25,
    children: [{ text: "" }],
    ...overrides,
  };
}

function invalid(rawBlock: string): InvalidBaseEmbedElement {
  return {
    type: "base-embed",
    status: "invalid",
    rawBlock,
    parseError: "Invalid source",
    children: [{ text: "" }],
  };
}

function renderInspector(
  node: BaseEmbedElement = configured(),
  overrides: Partial<ComponentProps<typeof BaseEmbedInspector>> = {},
) {
  const onSave = vi.fn();
  const onCancel = vi.fn();
  const onRestoreFocus = vi.fn();
  const rendered = render(
    <BaseEmbedInspector
      isOpen
      node={node}
      onSave={onSave}
      onCancel={onCancel}
      onRestoreFocus={onRestoreFocus}
      {...overrides}
    />,
  );
  const rerenderInspector = (nextNode: BaseEmbedElement, isOpen = true) => {
    rendered.rerender(
      <BaseEmbedInspector
        isOpen={isOpen}
        node={nextNode}
        onSave={onSave}
        onCancel={onCancel}
        onRestoreFocus={onRestoreFocus}
        {...overrides}
      />,
    );
  };
  return { onSave, onCancel, onRestoreFocus, rerenderInspector };
}

beforeEach(() => {
  apiState.bases = {
    data: {
      bases: [
        {
          slug: "reading",
          name: "Reading Log",
          diagnostic_count: 0,
          match_count: 2,
          views: ["All", "Unread"],
        },
        {
          slug: "tasks",
          name: "Tasks",
          diagnostic_count: 0,
          match_count: 3,
          views: ["Open", "Closed"],
        },
      ],
      diagnostics: [],
    },
    isPending: false,
    isFetching: false,
    error: null,
  };
  apiState.details = {
    reading: {
      data: reading,
      isPending: false,
      isFetching: false,
      error: null,
    },
    tasks: {
      data: tasks,
      isPending: false,
      isFetching: false,
      error: null,
    },
  };
});

describe("BaseEmbedInspector structured mode", () => {
  it("labels and describes controls and places initial focus on Base", async () => {
    renderInspector();

    expect(
      screen.getByRole("dialog", { name: "Configure Base embed" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("dialog", { name: "Configure Base embed" }),
    ).toHaveAccessibleDescription(/saved Base view and local query overrides/i);
    const base = screen.getByRole("combobox", { name: "Base" });
    expect(base).toHaveFocus();
    expect(base).toHaveAccessibleDescription(/saved Base/i);
    expect(
      screen.getByRole("combobox", { name: "Saved view" }),
    ).toHaveAccessibleDescription(/selected Base/i);
    expect(screen.getByRole("spinbutton", { name: "Limit" })).toHaveAttribute(
      "min",
      "1",
    );
    expect(screen.getByRole("spinbutton", { name: "Limit" })).toHaveAttribute(
      "max",
      "200",
    );
    expect(screen.getAllByLabelText("Embed filter")).not.toHaveLength(0);
  });

  it("changes Base atomically in the draft and resets view, filter, and sort but not limit", async () => {
    const user = userEvent.setup();
    renderInspector(
      configured({
        filter: { field: "rating", op: "gte", value: 4 },
        sort: [{ field: "rating", dir: "desc" }],
        limit: 37,
      }),
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Base" }),
      "tasks",
    );

    expect(screen.getByRole("combobox", { name: "Saved view" })).toHaveValue(
      "Open",
    );
    expect(screen.getByText("All pages")).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Sort field 1" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "Limit" })).toHaveValue(37);
  });

  it("changes view while preserving filter and limit and resetting sort to inherited", async () => {
    const user = userEvent.setup();
    renderInspector(
      configured({
        filter: { field: "rating", op: "gte", value: 4 },
        sort: [{ field: "rating", dir: "desc" }],
        limit: 37,
      }),
    );

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Saved view" }),
      "Unread",
    );

    expect(
      screen.getByRole("combobox", { name: "Field for condition 1" }),
    ).toHaveValue("rating");
    expect(screen.getByRole("spinbutton", { name: "Limit" })).toHaveValue(37);
    expect(screen.queryByRole("combobox", { name: "Sort field 1" })).toBeNull();
  });

  it.each([
    ["inherited", undefined],
    ["explicit no-sort", []],
    ["replacement", [{ field: "rating", dir: "desc" }]],
  ] as const)(
    "round-trips %s sort after an unrelated edit",
    async (_name, sort) => {
      const user = userEvent.setup();
      const callbacks = renderInspector(
        configured({
          sort:
            sort === undefined
              ? undefined
              : sort.map((key) => ({ ...key })),
        }),
      );

      const limit = screen.getByRole("spinbutton", { name: "Limit" });
      await user.clear(limit);
      await user.type(limit, "26");
      await user.click(screen.getByRole("button", { name: "Save" }));

      const saved = callbacks.onSave.mock.calls[0]?.[0];
      if (sort === undefined) expect(saved).not.toHaveProperty("sort");
      else expect(saved?.sort).toEqual(sort);
    },
  );

  it("keeps removing the final sort key as explicit no-sort", async () => {
    const user = userEvent.setup();
    const callbacks = renderInspector(
      configured({ sort: [{ field: "rating", dir: "desc" }] }),
    );

    await user.click(screen.getByRole("button", { name: "Remove sort 1" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(callbacks.onSave.mock.calls[0]?.[0]).toHaveProperty("sort", []);
  });

  it("offers an explicit accessible control to restore inherited sorting", async () => {
    const user = userEvent.setup();
    const callbacks = renderInspector(configured({ sort: [] }));
    const inherit = screen.getByRole("radio", {
      name: "Inherit saved view sorting",
    });

    expect(inherit).not.toBeChecked();
    expect(
      screen.getByRole("radio", { name: "Override saved view sorting" }),
    ).toBeChecked();
    await user.click(inherit);
    expect(inherit).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(callbacks.onSave.mock.calls[0]?.[0]).not.toHaveProperty("sort");
  });

  it("emits one complete configured node only after valid Save", async () => {
    const user = userEvent.setup();
    const { onSave, onRestoreFocus } = renderInspector();

    await user.clear(screen.getByRole("spinbutton", { name: "Limit" }));
    await user.type(screen.getByRole("spinbutton", { name: "Limit" }), "80");
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      type: "base-embed",
      status: "configured",
      base: "reading",
      view: "All",
      limit: 80,
      children: [{ text: "" }],
    });
    expect(onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it("keeps edits local and Cancel/Escape report no write and restore focus", async () => {
    const user = userEvent.setup();
    const first = renderInspector();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Base" }),
      "tasks",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(first.onSave).not.toHaveBeenCalled();
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    expect(first.onRestoreFocus).toHaveBeenCalledTimes(1);

    first.onCancel.mockClear();
    first.onRestoreFocus.mockClear();
    await user.keyboard("{Escape}");
    expect(first.onSave).not.toHaveBeenCalled();
    expect(first.onCancel).toHaveBeenCalledTimes(1);
    expect(first.onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it("resets canceled drafts only for a new open session and preserves ordinary rerenders", async () => {
    const user = userEvent.setup();
    const original = configured();
    const callbacks = renderInspector(original);
    const base = screen.getByRole("combobox", { name: "Base" });

    await user.selectOptions(base, "tasks");
    callbacks.rerenderInspector(original);
    expect(base).toHaveValue("tasks");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    callbacks.rerenderInspector(original, false);
    callbacks.rerenderInspector(original, true);
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Base" })).toHaveValue(
        "reading",
      ),
    );
  });

  it("resets the session when the inspected node identity is replaced", async () => {
    const first = configured();
    const callbacks = renderInspector(first);
    const repaired = invalid('````base\nbase = "tasks"\nview = "Open"\n````\n');

    callbacks.rerenderInspector(repaired);
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Base embed TOML" }),
      ).toHaveValue('base = "tasks"\nview = "Open"\n'),
    );

    callbacks.rerenderInspector(configured({ base: "tasks", view: "Open" }));
    expect(await screen.findByRole("combobox", { name: "Base" })).toHaveValue(
      "tasks",
    );
  });

  it("keeps missing Base and view references visible and recoverable", async () => {
    const user = userEvent.setup();
    renderInspector(configured({ base: "gone", view: "Renamed" }));

    expect(screen.getByRole("combobox", { name: "Base" })).toHaveValue("gone");
    expect(
      screen.getByRole("option", { name: "gone (missing)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText(/Base.*gone.*not found/i)).toBeInTheDocument();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Base" }),
      "reading",
    );
    expect(screen.getByRole("combobox", { name: "Saved view" })).toHaveValue(
      "All",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("repairs a missing saved view without changing the Base", async () => {
    const user = userEvent.setup();
    renderInspector(configured({ view: "Renamed" }));

    const view = screen.getByRole("combobox", { name: "Saved view" });
    expect(view).toHaveValue("Renamed");
    expect(
      screen.getByRole("option", { name: "Renamed (missing)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.selectOptions(view, "Unread");
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("accepts case-only saved-view spellings without rewriting them on Save", async () => {
    const user = userEvent.setup();
    const callbacks = renderInspector(configured({ view: "aLL" }));

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(callbacks.onSave.mock.calls[0]?.[0]).toMatchObject({ view: "aLL" });
  });

  it("disables Save while the selected Base detail is refreshing", () => {
    apiState.details.reading.isFetching = true;
    renderInspector();

    expect(screen.getByRole("status")).toHaveTextContent(
      /refreshing Base configuration/i,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("shows a settled selected-Base detail error and blocks Save", () => {
    apiState.details.reading = {
      data: undefined,
      isPending: false,
      isFetching: false,
      error: new Error("network unavailable"),
    };
    renderInspector();

    expect(screen.getByRole("alert")).toHaveTextContent(
      /could not load Reading Log details/i,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("blocks Save when a settled refetch error retains matching cached detail", () => {
    apiState.details.reading = {
      data: reading,
      isPending: false,
      isFetching: false,
      error: new Error("refetch unavailable"),
    };
    renderInspector();

    expect(screen.getByRole("alert")).toHaveTextContent(
      /could not load Reading Log details/i,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("ignores delayed stale detail and enables Save only after matching detail arrives", async () => {
    const user = userEvent.setup();
    apiState.details.tasks = {
      data: reading,
      isPending: true,
      isFetching: true,
      error: null,
    };
    const original = configured();
    const callbacks = renderInspector(original);

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Base" }),
      "tasks",
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(
      screen.queryByRole("option", { name: "rating" }),
    ).not.toBeInTheDocument();

    apiState.details.tasks = {
      data: tasks,
      isPending: false,
      isFetching: false,
      error: null,
    };
    callbacks.rerenderInspector(original);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
  });

  it("shows declared-field diagnostics and disables Save without stale results after rapid Base changes", async () => {
    const user = userEvent.setup();
    renderInspector(
      configured({
        filter: { field: "rating", op: "eq", value: 5 },
        sort: [{ field: "rating", dir: "asc" }],
      }),
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Base" }),
      "tasks",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Base" }),
      "reading",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Base" }),
      "tasks",
    );

    await waitFor(() => {
      expect(screen.getByRole("combobox", { name: "Saved view" })).toHaveValue(
        "Open",
      );
      expect(screen.queryByText(/rating.*not declared/i)).toBeNull();
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    });
  });

  it("diagnoses undeclared configured filter and sort fields at their controls", () => {
    renderInspector(
      configured({
        filter: { field: "foreign", op: "eq", value: "x" },
        sort: [{ field: "foreign", dir: "asc" }],
      }),
    );

    expect(
      screen.getByRole("combobox", { name: "Field for condition 1" }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(
      screen.getByRole("combobox", { name: "Sort field 1" }),
    ).toHaveAttribute("aria-invalid", "true");
    expect(screen.getAllByText(/unknown field.*foreign/i)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("blocks Save for selected-Base operator and value incompatibilities", () => {
    const { rerenderInspector } = renderInspector(
      configured({
        filter: { field: "rating", op: "contains", value: 5 },
      }),
    );

    expect(screen.getByText(/op.*contains.*not valid/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    rerenderInspector(
      configured({ filter: { field: "rating", op: "eq", value: "five" } }),
    );
    expect(screen.getByText(/expected a number/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it.each([
    [0, false],
    [1, true],
    [200, true],
    [201, false],
  ])("validates limit %i", (limit, valid) => {
    renderInspector(configured({ limit }));
    const control = screen.getByRole("spinbutton", { name: "Limit" });
    expect(control).toHaveAttribute("aria-invalid", valid ? "false" : "true");
    if (valid) {
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    } else {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    }
  });
});

describe("pure Base embed validation bounds", () => {
  function comparison(field = "title", value: unknown = "x"): BaseFilter {
    return { field, op: "eq", value };
  }

  function nestedNot(depth: number): BaseFilter {
    let filter = comparison();
    for (let index = 1; index < depth; index += 1) filter = { not: filter };
    return filter;
  }

  function nodeCountFilter(groups: number, direct: number): BaseFilter {
    return {
      all: [
        ...Array.from(
          { length: groups },
          () => ({ all: [comparison()] }) as BaseFilter,
        ),
        ...Array.from({ length: direct }, () => comparison()),
      ],
    };
  }

  const valid = (overrides: Record<string, unknown> = {}) => ({
    base: "reading",
    view: "All",
    ...overrides,
  });

  const eightSortableFields = [
    "id",
    "path",
    "title",
    "kind",
    "project",
    "created_at",
    "updated_at",
    "journal_date",
  ];

  it.each([
    ["depth", valid({ filter: nestedNot(8) }), true, "filter"],
    ["depth", valid({ filter: nestedNot(9) }), false, "filter.not"],
    ["nodes", valid({ filter: nodeCountFilter(31, 1) }), true, "filter"],
    ["nodes", valid({ filter: nodeCountFilter(32, 0) }), false, "filter"],
    [
      "group children",
      valid({
        filter: { all: Array.from({ length: 32 }, () => comparison()) },
      }),
      true,
      "filter",
    ],
    [
      "group children",
      valid({
        filter: { all: Array.from({ length: 33 }, () => comparison()) },
      }),
      false,
      "filter.all",
    ],
    [
      "in values",
      valid({
        filter: { field: "kind", op: "in", value: Array(100).fill("NOTE") },
      }),
      true,
      "filter",
    ],
    [
      "in values",
      valid({
        filter: { field: "kind", op: "in", value: Array(101).fill("NOTE") },
      }),
      false,
      "filter.value",
    ],
    [
      "sort keys",
      valid({ sort: eightSortableFields.map((field) => ({ field })) }),
      true,
      "sort",
    ],
    [
      "sort keys",
      valid({ sort: Array.from({ length: 9 }, () => ({ field: "title" })) }),
      false,
      "sort",
    ],
    [
      "field bytes",
      valid({ sort: [{ field: "é".repeat(128) }] }),
      true,
      "sort",
    ],
    [
      "field bytes",
      valid({ sort: [{ field: "é".repeat(129) }] }),
      false,
      "sort[0].field",
    ],
    [
      "string bytes",
      valid({ filter: comparison("title", "é".repeat(2048)) }),
      true,
      "filter",
    ],
    [
      "string bytes",
      valid({ filter: comparison("title", "é".repeat(2049)) }),
      false,
      "filter.value",
    ],
    ["body bytes", valid({ base: "x".repeat(65_536 - 23) }), true, "base"],
    ["body bytes", valid({ base: "x".repeat(65_536 - 22) }), false, "$"],
  ])("checks %s at N and N+1", (_name, value, isValid, path) => {
    const diagnostics = validateBaseEmbedConfig(value);
    expect(diagnostics.length === 0).toBe(isValid);
    if (!isValid) expect(diagnostics[0]?.path).toContain(path);
  });

  it.each([
    ["depth", valid({ filter: nestedNot(8) })],
    ["nodes", valid({ filter: nodeCountFilter(31, 1) })],
    [
      "group children",
      valid({
        filter: { all: Array.from({ length: 32 }, () => comparison()) },
      }),
    ],
    [
      "in values",
      valid({
        filter: {
          field: "kind",
          op: "in",
          value: Array(100).fill("NOTE"),
        },
      }),
    ],
    [
      "sort keys",
      valid({
        sort: eightSortableFields.map((field) => ({ field })),
      }),
    ],
    ["field bytes", valid({ sort: [{ field: "é".repeat(128) }] })],
    ["string bytes", valid({ filter: comparison("title", "é".repeat(2048)) })],
    ["body bytes", valid({ base: "x".repeat(65_536 - 23) })],
  ])("keeps Save enabled for %s at N", (_name, value) => {
    if (_name === "field bytes") {
      const field = "é".repeat(128);
      const properties = apiState.details.reading.data?.properties;
      if (properties) properties[field] = { type: "text" };
    }
    const slug = String(value.base);
    if (!apiState.details[slug]) {
      apiState.bases.data?.bases.push({
        slug,
        name: "Boundary Base",
        diagnostic_count: 0,
        match_count: 0,
        views: ["All"],
      });
      apiState.details[slug] = {
        data: detail(slug, "Boundary Base", ["All"]),
        isPending: false,
        isFetching: false,
        error: null,
      };
    }
    renderInspector(
      configured({
        ...(value as Partial<ConfiguredBaseEmbedElement>),
        ...(_name === "body bytes" ? { limit: undefined } : {}),
      }),
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it.each([
    ["depth", valid({ filter: nestedNot(9) }), /Filter depth 9 exceeds/i],
    ["nodes", valid({ filter: nodeCountFilter(32, 0) }), /more than 64 nodes/i],
    [
      "group children",
      valid({
        filter: { all: Array.from({ length: 33 }, () => comparison()) },
      }),
      /33 children; maximum is 32/i,
    ],
    [
      "in values",
      valid({
        filter: {
          field: "kind",
          op: "in",
          value: Array(101).fill("NOTE"),
        },
      }),
      /at most 100 values/i,
    ],
    [
      "sort keys",
      valid({
        sort: Array.from({ length: 9 }, () => ({ field: "title" })),
      }),
      /9 keys; maximum is 8/i,
    ],
    [
      "field bytes",
      valid({ sort: [{ field: "é".repeat(129) }] }),
      /258 UTF-8 bytes; maximum is 256/i,
    ],
    [
      "string bytes",
      valid({ filter: comparison("title", "é".repeat(2049)) }),
      /4098 UTF-8 bytes; maximum is 4096/i,
    ],
    [
      "canonical body",
      valid({
        filter: {
          all: Array.from({ length: 16 }, () =>
            comparison("title", "x".repeat(4096)),
          ),
        },
      }),
      /TOML body exceeds 65536 UTF-8 bytes/i,
    ],
  ])(
    "renders the owning %s diagnostic and disables Save",
    (_name, value, message) => {
      renderInspector(configured(value as Partial<ConfiguredBaseEmbedElement>));
      expect(screen.getAllByText(message).length).toBeGreaterThan(0);

      const owner =
        _name === "canonical body"
          ? screen.getByRole("dialog", { name: "Configure Base embed" })
          : _name === "sort keys"
            ? screen.getByRole("region", { name: "Sort order" })
            : _name === "depth" ||
                _name === "nodes" ||
                _name === "group children"
              ? screen.getByRole("region", { name: "Embed filter" })
              : _name === "field bytes"
                ? screen.getByRole("combobox", { name: "Sort field 1" })
                : screen.getByRole("textbox", {
                    name: "Value for condition 1",
                  });
      expect(owner).toHaveAccessibleDescription(message);
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    },
  );
});

function expectAllDescriptionTargetsToExist(element: HTMLElement) {
  const ids = element.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
  expect(ids.length).toBeGreaterThan(0);
  for (const id of ids) expect(document.getElementById(id)).not.toBeNull();
}

describe("BaseEmbedInspector source repair", () => {
  it.each([
    [
      "long CRLF fence",
      '````base\r\nbase = "reading"\r\nview = "All"\r\n````\r\n',
      'base = "reading"\r\nview = "All"\r\n',
    ],
    [
      "unclosed fence",
      '```base\nbase = "reading"\nview = "All"',
      'base = "reading"\nview = "All"',
    ],
  ])("extracts only the TOML body from %s", (_name, rawBlock, body) => {
    renderInspector(invalid(rawBlock));
    expect(extractBaseEmbedTomlBody(rawBlock)).toBe(body);
    expect(
      screen.getByRole("textbox", { name: "Base embed TOML" }),
    ).toHaveValue(body.replaceAll("\r\n", "\n"));
    expect(
      screen.getByRole("textbox", { name: "Base embed TOML" }),
    ).toHaveFocus();
    expect(
      screen.getByRole("dialog", { name: "Configure Base embed" }),
    ).toHaveAccessibleDescription(/Repair the persisted TOML/i);
  });

  it("keeps invalid source local on Cancel", async () => {
    const user = userEvent.setup();
    const callbacks = renderInspector(invalid("```base\nnot toml\n```\n"));
    const source = screen.getByRole("textbox", { name: "Base embed TOML" });
    await user.clear(source);
    await user.type(source, 'base = "reading"\nview = "All"\n');
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(callbacks.onSave).not.toHaveBeenCalled();
    expect(callbacks.onCancel).toHaveBeenCalledTimes(1);
    expect(callbacks.onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it("validates source and replaces the whole invalid node once on Save", async () => {
    const user = userEvent.setup();
    const callbacks = renderInspector(invalid("`````base\nnot toml\n`````\n"));
    const source = screen.getByRole("textbox", { name: "Base embed TOML" });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(source).toHaveAccessibleDescription(/valid TOML/i);
    expectAllDescriptionTargetsToExist(
      screen.getByRole("dialog", { name: "Configure Base embed" }),
    );
    expectAllDescriptionTargetsToExist(source);

    await user.clear(source);
    await user.type(source, 'base = "reading"\nview = "All"\nlimit = 40\n');
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(callbacks.onSave).toHaveBeenCalledTimes(1);
    expect(callbacks.onSave).toHaveBeenCalledWith(configured({ limit: 40 }));
    expect(callbacks.onRestoreFocus).toHaveBeenCalledTimes(1);
  });

  it("applies selected-Base semantics to repaired source before Save", async () => {
    const user = userEvent.setup();
    const validCallbacks = renderInspector(
      invalid(
        '```base\nbase = "reading"\nview = "aLL"\nfilter = { field = "sys.kind", op = "eq", value = "NOTE" }\nsort = [{ field = "prop.rating" }]\n```\n',
      ),
    );

    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(validCallbacks.onSave).toHaveBeenCalledTimes(1);

    validCallbacks.rerenderInspector(
      invalid(
        '```base\nbase = "reading"\nview = "All"\nsort = [{ field = "title" }, { field = "sys.title" }]\n```\n',
      ),
    );
    expect(
      await screen.findByText(/duplicate canonical sort field/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("does not validate repaired source against stale detail from another Base", async () => {
    const tasksSummary = apiState.bases.data?.bases.find(
      ({ slug }) => slug === "tasks",
    );
    if (!tasksSummary) throw new Error("test fixture requires the tasks Base");
    tasksSummary.views = ["All"];
    apiState.details.tasks = {
      data: reading,
      isPending: false,
      isFetching: false,
      error: null,
    };
    const repaired = invalid(
      '```base\nbase = "tasks"\nview = "All"\nfilter = { field = "priority", op = "gte", value = 3 }\n```\n',
    );
    const callbacks = renderInspector(repaired);
    const source = screen.getByRole("textbox", { name: "Base embed TOML" });

    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(source).toHaveAccessibleDescription(
      /Could not load Tasks details/i,
    );
    expect(screen.queryByText(/unknown field.*priority/i)).toBeNull();

    apiState.details.tasks = {
      data: detail("tasks", "Tasks", ["All"], {
        priority: { type: "number" },
      }),
      isPending: false,
      isFetching: false,
      error: null,
    };
    callbacks.rerenderInspector(repaired);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Save" })).toBeEnabled(),
    );
  });

  it("applies canonical representation size validation before source-repair Save", () => {
    const literal = `'${"\\".repeat(3500)}'`;
    const body = `base = "reading"\nview = "All"\nfilter = { field = "title", op = "in", value = [${Array(
      10,
    )
      .fill(literal)
      .join(", ")}] }\n`;
    renderInspector(invalid(`\`\`\`base\n${body}\`\`\`\n`));
    expect(
      screen.getByText(/TOML body exceeds 65536 UTF-8 bytes/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    const dialog = screen.getByRole("dialog", {
      name: "Configure Base embed",
    });
    expectAllDescriptionTargetsToExist(dialog);
    expect(dialog).not.toHaveAttribute(
      "aria-describedby",
      expect.stringContaining("base-embed-root-diagnostics"),
    );
  });
});

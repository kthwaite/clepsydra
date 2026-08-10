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
  render(
    <BaseEmbedInspector
      isOpen
      node={node}
      onSave={onSave}
      onCancel={onCancel}
      onRestoreFocus={onRestoreFocus}
      {...overrides}
    />,
  );
  return { onSave, onCancel, onRestoreFocus };
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

  it("disables Save while the selected Base detail is refreshing", () => {
    apiState.details.reading.isFetching = true;
    renderInspector();

    expect(screen.getByRole("status")).toHaveTextContent(
      /refreshing Base configuration/i,
    );
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
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
    expect(screen.getAllByText(/foreign.*not declared/i)).toHaveLength(2);
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
      valid({ sort: Array.from({ length: 8 }, () => ({ field: "title" })) }),
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
});

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

    await user.clear(source);
    await user.type(source, 'base = "reading"\nview = "All"\nlimit = 40\n');
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(callbacks.onSave).toHaveBeenCalledTimes(1);
    expect(callbacks.onSave).toHaveBeenCalledWith(configured({ limit: 40 }));
    expect(callbacks.onRestoreFocus).toHaveBeenCalledTimes(1);
  });
});

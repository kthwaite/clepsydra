import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BaseFilter } from "#/api/bases";
import type { BaseDiagnostic } from "#/components/bases/BaseDefinitionWorkspace";
import { createFilterDiagnosticScope } from "#/components/bases/filter-diagnostics";
import { TagConditionEditor } from "#/components/bases/TagConditionEditor";

const tagsQuery = vi.hoisted(() => ({
  data: undefined as Array<{ tag: string; count: number }> | undefined,
}));

vi.mock("#/api/index", () => ({
  useTags: () => tagsQuery,
}));

beforeEach(() => {
  tagsQuery.data = [
    { tag: "beer", count: 12 },
    { tag: "brewing", count: 4 },
    { tag: "wine", count: 7 },
  ];
});

function latest(mock: Mock): BaseFilter | undefined {
  return mock.mock.calls.at(-1)?.[0];
}

function renderRow(value: BaseFilter, diagnostics: BaseDiagnostic[] = []) {
  const onChange = vi.fn();
  const registerFocus = vi.fn();
  const diagnosticScope = createFilterDiagnosticScope({
    root: "filter",
    path: [],
    diagnostics,
    registerFocus,
  });
  const { unmount } = render(
    <TagConditionEditor
      value={value}
      position={1}
      properties={[]}
      onChange={onChange}
      diagnosticScope={diagnosticScope}
    />,
  );
  return { onChange, registerFocus, unmount };
}

async function chooseOption(user: UserEvent, trigger: RegExp, option: RegExp) {
  await user.click(screen.getByRole("button", { name: trigger }));
  await user.click(await screen.findByRole("option", { name: option }));
}

describe("TagConditionEditor", () => {
  it("presents the quantifier and values of an all-of condition", () => {
    renderRow({
      all: [
        { field: "tags", op: "contains", value: "beer" },
        { field: "tags", op: "contains", value: "brewing" },
      ],
    });

    expect(
      screen.getByRole("button", { name: /field for condition 1/i }),
    ).toHaveTextContent(/tags/i);
    expect(
      screen.getByRole("button", { name: /operator for condition 1/i }),
    ).toHaveTextContent(/has all of/i);
    // Tag chips carry the vault's `#` prefix, as in the Inscribe modal.
    const values = screen.getByRole("grid", { name: /values for condition 1/i });
    expect(within(values).getByText("#beer")).toBeVisible();
    expect(within(values).getByText("#brewing")).toBeVisible();
  });

  it("rewrites the filter when the quantifier changes", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRow({
      all: [
        { field: "tags", op: "contains", value: "beer" },
        { field: "tags", op: "contains", value: "wine" },
      ],
    });

    await chooseOption(user, /operator for condition 1/i, /has none of/i);

    expect(latest(onChange)).toEqual({
      not: { field: "tags", op: "in", value: ["beer", "wine"] },
    });
  });

  it("adds a typed value to the condition", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRow({
      field: "tags",
      op: "in",
      value: ["beer"],
    });

    await user.type(
      screen.getByRole("combobox", { name: /values for condition 1/i }),
      "cider{Enter}",
    );

    expect(latest(onChange)).toEqual({
      field: "tags",
      op: "in",
      value: ["beer", "cider"],
    });
  });

  it("offers vault tags as suggestions", async () => {
    const user = userEvent.setup();
    renderRow({ field: "tags", op: "in", value: ["beer"] });

    await user.type(
      screen.getByRole("combobox", { name: /values for condition 1/i }),
      "bre",
    );

    expect(await screen.findByRole("option", { name: /brewing/ })).toBeVisible();
  });

  it("switches the condition between tags and aliases", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRow({
      field: "tags",
      op: "in",
      value: ["beer", "wine"],
    });

    await chooseOption(user, /field for condition 1/i, /^aliases$/i);

    expect(latest(onChange)).toEqual({
      field: "aliases",
      op: "in",
      value: ["beer", "wine"],
    });
  });

  it("keeps the stored encoding when only the values change", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRow({
      any: [
        { field: "tags", op: "contains", value: "beer" },
        { field: "tags", op: "contains", value: "wine" },
      ],
    });

    await user.type(
      screen.getByRole("combobox", { name: /values for condition 1/i }),
      "cider{Enter}",
    );

    expect(latest(onChange)).toEqual({
      any: [
        { field: "tags", op: "contains", value: "beer" },
        { field: "tags", op: "contains", value: "wine" },
        { field: "tags", op: "contains", value: "cider" },
      ],
    });
  });

  it("reveals the advanced condition row without changing the filter", async () => {
    const user = userEvent.setup();
    const { onChange } = renderRow({
      field: "tags",
      op: "in",
      value: ["beer"],
    });

    await user.click(
      screen.getByRole("button", { name: /edit condition 1 as an advanced condition/i }),
    );

    expect(
      screen.getByRole("button", { name: /operator for condition 1/i }),
    ).toHaveTextContent(/in/i);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("registers each subsumed diagnostic path to one compact-row target and cleans up", () => {
    const { registerFocus, unmount } = renderRow(
      {
        all: [
          { field: "tags", op: "contains", value: "beer" },
          { field: "tags", op: "contains", value: "wine" },
        ],
      },
      [
        {
          severity: "error",
          message: "unknown tag `beer`",
          path: "filter.all[0].value",
        },
        {
          severity: "error",
          message: "unknown tag `wine`",
          path: "filter.all[1].value",
        },
      ] as BaseDiagnostic[],
    );

    expect(screen.getAllByRole("alert")).toHaveLength(2);
    const firstTarget = registerFocus.mock.calls.find(
      ([path, element]) =>
        path === "filter.all[0].value" && element instanceof HTMLElement,
    )?.[1];
    const secondTarget = registerFocus.mock.calls.find(
      ([path, element]) =>
        path === "filter.all[1].value" && element instanceof HTMLElement,
    )?.[1];
    expect(firstTarget).toBeInstanceOf(HTMLElement);
    expect(secondTarget).toBe(firstTarget);

    unmount();

    expect(registerFocus).toHaveBeenCalledWith("filter.all[0].value", null);
    expect(registerFocus).toHaveBeenCalledWith("filter.all[1].value", null);
  });
});

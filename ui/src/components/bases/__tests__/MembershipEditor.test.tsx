import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BaseFilter } from "#/api/bases";
import { CreateBaseDialog } from "#/components/bases/CreateBaseDialog";
import type { DraftProperty } from "#/components/bases/definition-model";
import { MembershipEditor } from "#/components/bases/MembershipEditor";

const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

const properties: DraftProperty[] = [
  {
    id: "status-property",
    key: "status",
    definition: { type: "select", options: ["queued", "reading"] },
  },
  {
    id: "topics-property",
    key: "topics",
    definition: { type: "multi_select", options: ["craft", "theory"] },
  },
  {
    id: "rating-property",
    key: "rating",
    definition: { type: "number" },
  },
  {
    id: "published-property",
    key: "published",
    definition: { type: "bool" },
  },
  {
    id: "source-property",
    key: "source",
    definition: { type: "relation" },
  },
];

function latest(mock: Mock): BaseFilter | undefined {
  return mock.mock.calls.at(-1)?.[0];
}

function renderEditor(value?: BaseFilter, registerFocus = vi.fn()) {
  const onChange = vi.fn();
  const view = render(
    <MembershipEditor
      value={value}
      properties={properties}
      onChange={onChange}
      registerFocus={registerFocus}
    />,
  );
  return { ...view, onChange, registerFocus };
}

describe("MembershipEditor", () => {
  beforeEach(() => navigateMock.mockReset());

  it("shows All pages and builds a field comparison", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    expect(screen.getByText("All pages")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "kind",
    );
    await user.selectOptions(
      screen.getByLabelText("Operator for condition 1"),
      "eq",
    );
    await user.type(screen.getByLabelText("Value for condition 1"), "BOOK");

    expect(latest(onChange)).toEqual({
      field: "kind",
      op: "eq",
      value: "BOOK",
    });
  });

  it("creates all, any, and not nodes without an interim filter shape", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await user.click(
      screen.getByRole("button", { name: "Add Match all group" }),
    );
    expect(latest(onChange)).toEqual({ all: [] });
    expect(
      screen.getByRole("group", { name: "Match all conditions" }),
    ).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Replace with Match any group" }),
    );
    expect(latest(onChange)).toEqual({ any: [] });

    await user.click(
      screen.getByRole("button", { name: "Replace with Not condition" }),
    );
    expect(latest(onChange)).toEqual({
      not: { field: "kind", op: "eq", value: "" },
    });
  });

  it("labels nested boolean structure and exposes positional controls", () => {
    renderEditor({
      all: [{ field: "kind", op: "eq", value: "BOOK" }, { any: [] }],
    });

    const all = screen.getByRole("group", {
      name: "Match all of 2 conditions",
    });
    expect(
      within(all).getByRole("group", { name: "Match any conditions" }),
    ).toBeInTheDocument();
    expect(
      within(all).getByRole("button", {
        name: "Convert condition 2 to Not condition",
      }),
    ).toBeInTheDocument();
    expect(
      within(all).getByRole("button", { name: "Remove condition 2" }),
    ).toBeInTheDocument();
  });

  it("edits nested nodes immutably and collapses only an empty root to All pages", async () => {
    const user = userEvent.setup();
    const original: BaseFilter = {
      all: [
        { field: "kind", op: "eq", value: "BOOK" },
        { any: [{ field: "status", op: "eq", value: "reading" }] },
      ],
    };
    const { onChange } = renderEditor(original);

    await user.click(
      screen.getAllByRole("button", { name: "Remove condition 1" })[0],
    );
    expect(latest(onChange)).toEqual({
      all: [{ any: [{ field: "status", op: "eq", value: "reading" }] }],
    });
    expect(original).toEqual({
      all: [
        { field: "kind", op: "eq", value: "BOOK" },
        { any: [{ field: "status", op: "eq", value: "reading" }] },
      ],
    });

    await user.click(
      within(
        screen.getByRole("group", { name: "Match any of 1 condition" }),
      ).getByRole("button", { name: "Remove condition 1" }),
    );
    expect(latest(onChange)).toBeUndefined();
    expect(screen.getByText("All pages")).toBeInTheDocument();
  });

  it("uses exact field capabilities and removes values for value-less operators", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      field: "tags",
      op: "contains",
      value: "research",
    });
    expect(screen.getByRole("option", { name: "ID" })).toHaveAttribute(
      "value",
      "id",
    );

    const operator = screen.getByLabelText("Operator for condition 1");
    expect(
      within(operator)
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["contains", "in", "is_empty", "not_empty"]);
    await user.selectOptions(operator, "is_empty");
    expect(latest(onChange)).toEqual({ field: "tags", op: "is_empty" });
    expect(screen.queryByLabelText("Value for condition 1")).toBeNull();

    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "source",
    );
    expect(
      within(screen.getByLabelText("Operator for condition 1"))
        .getAllByRole("option")
        .map((option) => option.getAttribute("value")),
    ).toEqual(["eq", "ne", "links_to", "is_empty", "not_empty"]);
  });

  it("uses declared option, boolean, numeric, and relation value affordances", async () => {
    const user = userEvent.setup();
    renderEditor({ field: "status", op: "eq", value: "queued" });

    expect(screen.getByLabelText("Value for condition 1")).toHaveRole(
      "combobox",
    );
    expect(screen.getByLabelText("Value for condition 1")).toHaveValue(
      "queued",
    );

    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "published",
    );
    expect(screen.getByLabelText("Value for condition 1")).toHaveRole(
      "combobox",
    );
    expect(screen.getByLabelText("Value for condition 1")).toHaveValue("true");

    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "rating",
    );
    expect(screen.getByLabelText("Value for condition 1")).toHaveAttribute(
      "type",
      "number",
    );

    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "source",
    );
    expect(screen.getByLabelText("Value for condition 1")).toHaveAttribute(
      "list",
    );
  });

  it("stores bool in values as arrays and preserves freeform comma entry", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      field: "published",
      op: "eq",
      value: true,
    });

    await user.selectOptions(
      screen.getByLabelText("Operator for condition 1"),
      "in",
    );
    const boolValues = screen.getByLabelText("Value for condition 1");
    expect(boolValues).toHaveRole("listbox");
    await user.selectOptions(boolValues, ["true", "false"]);
    expect(latest(onChange)).toEqual({
      field: "published",
      op: "in",
      value: [true, false],
    });

    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "tags",
    );
    await user.selectOptions(
      screen.getByLabelText("Operator for condition 1"),
      "in",
    );
    const freeform = screen.getByLabelText("Value for condition 1");
    await user.clear(freeform);
    await user.type(freeform, "alpha, beta");
    expect(freeform).toHaveValue("alpha, beta");
    expect(latest(onChange)).toEqual({
      field: "tags",
      op: "in",
      value: [],
    });
    await user.keyboard("{Enter}");
    expect(latest(onChange)).toEqual({
      field: "tags",
      op: "in",
      value: ["alpha", "beta"],
    });
  });

  it("keeps unsupported wire fields, operators, and option values visible", () => {
    const view = renderEditor({
      field: "prop.legacy_relation",
      op: "links_to",
      value: "Old Page",
    });

    expect(screen.getByLabelText("Field for condition 1")).toHaveValue(
      "prop.legacy_relation",
    );
    expect(
      screen.getByRole("option", {
        name: "prop.legacy_relation (undeclared)",
      }),
    ).toHaveValue("prop.legacy_relation");
    expect(screen.getByLabelText("Operator for condition 1")).toHaveValue(
      "links_to",
    );
    expect(
      screen.getByRole("option", { name: "links_to (unsupported)" }),
    ).toHaveValue("links_to");

    view.unmount();
    const removedOption = renderEditor({
      field: "status",
      op: "eq",
      value: "retired",
    });
    expect(screen.getByLabelText("Value for condition 1")).toHaveValue(
      "retired",
    );
    expect(
      screen.getByRole("option", { name: "retired (not declared)" }),
    ).toHaveValue("retired");

    removedOption.unmount();
    renderEditor({
      field: "topics",
      op: "in",
      value: ["craft", "lost", "other"],
    });
    expect(screen.getByLabelText("Value for condition 1")).toHaveValue([
      "craft",
      "lost",
      "other",
    ]);
    expect(
      screen.getByRole("option", { name: "lost (not declared)" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "other (not declared)" }),
    ).toBeInTheDocument();
  });

  it("registers exact recursive diagnostic focus paths", () => {
    const registerFocus = vi.fn();
    renderEditor(
      {
        all: [
          { field: "kind", op: "eq", value: "BOOK" },
          { not: { field: "status", op: "eq", value: "reading" } },
        ],
      },
      registerFocus,
    );

    const registeredPaths = registerFocus.mock.calls
      .filter((call) => call[1] instanceof HTMLElement)
      .map((call) => call[0]);
    expect(registeredPaths).toEqual(
      expect.arrayContaining([
        "filter.all[0].field",
        "filter.all[0].op",
        "filter.all[0].value",
        "filter.all[1].not.field",
        "filter.all[1].not.op",
        "filter.all[1].not.value",
      ]),
    );
  });

  it("supports keyboard activation for membership actions", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await user.tab();
    expect(screen.getByRole("button", { name: "Add condition" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(latest(onChange)).toEqual({ field: "kind", op: "eq", value: "" });
    expect(screen.getByLabelText("Field for condition 1")).toBeInTheDocument();
  });

  it("submits the membership rule edited during guided creation", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ slug: "books" });
    render(<CreateBaseDialog isOpen onClose={vi.fn()} onCreate={onCreate} />);

    await user.type(screen.getByLabelText("Name"), "Books");
    await user.click(screen.getByRole("button", { name: "Add condition" }));
    await user.selectOptions(
      screen.getByLabelText("Field for condition 1"),
      "kind",
    );
    await user.type(screen.getByLabelText("Value for condition 1"), "BOOK");
    await user.click(screen.getByRole("button", { name: "Create base" }));

    expect(onCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        definition: expect.objectContaining({
          filter: { field: "kind", op: "eq", value: "BOOK" },
        }),
      }),
    );
  });
});

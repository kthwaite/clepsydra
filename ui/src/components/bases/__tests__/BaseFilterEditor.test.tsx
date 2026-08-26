import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BaseFilter } from "#/api/bases";
import { CreateBaseDialog } from "#/components/bases/CreateBaseDialog";
import type { DraftProperty } from "#/components/bases/definition-model";
import { BaseFilterEditor } from "#/components/bases/BaseFilterEditor";
function selectTriggerName(label: string) {
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

/** Filter actions now live behind menus: open the trigger, pick the item. */
async function chooseMenuAction(
  user: UserEvent,
  trigger: string | RegExp,
  item: string | RegExp,
  scope: HTMLElement | undefined = undefined,
  // A group's own controls and those of its nested groups share names; nth
  // picks the outermost by document order.
  nth = 0,
) {
  const root = scope ? within(scope) : screen;
  await user.click(root.getAllByRole("button", { name: trigger })[nth]);
  await user.click(await screen.findByRole("menuitem", { name: item }));
}

async function chooseSelectOption(
  user: UserEvent,
  label: string,
  option: string,
) {
  const trigger = screen.getByRole("button", { name: selectTriggerName(label) });
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}


const navigateMock = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}));

vi.mock("#/api/index", () => ({
  useTags: () => ({ data: [{ tag: "beer", count: 3 }] }),
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
    <BaseFilterEditor
      value={value}
      properties={properties}
      onChange={onChange}
      registerFocus={registerFocus}
    />,
  );
  return { ...view, onChange, registerFocus };
}

describe("BaseFilterEditor", () => {
  beforeEach(() => navigateMock.mockReset());

  it("authors a filter without an external focus registrar", async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(
      <BaseFilterEditor value={undefined} properties={[]} onChange={onChange} />,
    );

    await chooseMenuAction(user, "Add rule", "Condition");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({
      field: "kind",
      op: "eq",
      value: "",
    });
  });

  it("wraps a nested condition in not through one root change", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      all: [{ field: "kind", op: "eq", value: "NOTE" }],
    });

    await chooseMenuAction(
      user,
      "Condition 1 actions",
      "Negate condition",
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      all: [{ not: { field: "kind", op: "eq", value: "NOTE" } }],
    });
  });

  it("collapses nested not and group ancestors after removing their sole child", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      all: [{ not: { field: "kind", op: "eq", value: "NOTE" } }],
    });

    await chooseMenuAction(
      user,
      "Excluded condition actions",
      "Remove excluded condition",
    );

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(undefined);
    expect(screen.getByText("All pages")).toBeInTheDocument();
  });

  it("appends a seeded condition to a nested group through one root change", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      all: [{ field: "kind", op: "eq", value: "NOTE" }],
    });

    await chooseMenuAction(user, "Add to Match all", "Condition");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      all: [
        { field: "kind", op: "eq", value: "NOTE" },
        { field: "kind", op: "eq", value: "" },
      ],
    });
  });

  it("moves one group child while preserving the exact sibling order", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor({
      all: [
        { field: "kind", op: "eq", value: "NOTE" },
        { field: "status", op: "eq", value: "draft" },
        { field: "title", op: "eq", value: "Third" },
      ],
    });

    await chooseMenuAction(user, "Condition 2 actions", "Move down");

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      all: [
        { field: "kind", op: "eq", value: "NOTE" },
        { field: "title", op: "eq", value: "Third" },
        { field: "status", op: "eq", value: "draft" },
      ],
    });
  });

  it("replaces its controlled root without emitting an authoring change", () => {
    const onChange = vi.fn();
    const view = render(
      <BaseFilterEditor
        value={{ field: "kind", op: "eq", value: "NOTE" }}
        properties={properties}
        onChange={onChange}
      />,
    );

    view.rerender(
      <BaseFilterEditor
        value={{ field: "title", op: "eq", value: "After" }}
        properties={properties}
        onChange={onChange}
      />,
    );

    expect(
      screen.getByRole("button", {
        name: selectTriggerName("Field for condition 1"),
      }),
    ).toHaveTextContent("Title");
    expect(screen.getByLabelText("Value for condition 1")).toHaveValue("After");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("shows All pages and builds a field comparison", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    expect(screen.getByText("All pages")).toBeInTheDocument();
    await chooseMenuAction(user, "Add rule", "Condition");
    await chooseSelectOption(user, "Field for condition 1", "Kind");
    await chooseSelectOption(user, "Operator for condition 1", "eq");
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

    await chooseMenuAction(user, "Add rule", "Match all group");
    expect(latest(onChange)).toEqual({ all: [] });
    expect(
      screen.getByRole("group", { name: "Match all conditions" }),
    ).toBeInTheDocument();

    await chooseMenuAction(
      user,
      "Membership actions",
      "Replace with Match any group",
    );
    expect(latest(onChange)).toEqual({ any: [] });

    await chooseMenuAction(
      user,
      "Membership actions",
      "Replace with Not condition",
    );
    expect(latest(onChange)).toEqual({
      not: { field: "kind", op: "eq", value: "" },
    });
  });

  it("turns a condition into a tag row when its field is a tag field", async () => {
    const user = userEvent.setup();
    const { onChange } = renderEditor();

    await chooseMenuAction(user, "Add rule", "Condition");
    await chooseSelectOption(user, "Field for condition 1", "Tags");

    // The generic operator list gives way to the tag quantifiers.
    const operator = screen.getByRole("button", {
      name: /operator for condition 1/i,
    });
    expect(operator).toHaveTextContent(/has all of/i);
    await user.click(operator);
    await user.click(await screen.findByRole("option", { name: /has any of/i }));
    const values = screen.getByRole("combobox", {
      name: /values for condition 1/i,
    });
    await user.type(values, "beer{Enter}");

    // One value needs no quantifier: the row keeps the simplest node that
    // expresses the predicate, and only spells out `in` once it must.
    expect(latest(onChange)).toEqual({
      field: "tags",
      op: "contains",
      value: "beer",
    });
    expect(
      screen.getByRole("button", { name: /operator for condition 1/i }),
    ).toHaveTextContent(/has any of/i);

    await user.type(values, "tasting{Enter}");
    expect(latest(onChange)).toEqual({
      field: "tags",
      op: "in",
      value: ["beer", "tasting"],
    });
  });

  it("presents a stored tag predicate as one row instead of a nested group", () => {
    renderEditor({
      all: [
        { field: "tags", op: "contains", value: "beer" },
        { field: "tags", op: "contains", value: "tasting" },
      ],
    });

    expect(
      screen.getByRole("button", { name: /operator for condition 1/i }),
    ).toHaveTextContent(/has all of/i);
    expect(
      screen.queryByRole("group", { name: /match all conditions/i }),
    ).not.toBeInTheDocument();
  });

  it("labels nested boolean structure and exposes positional controls", async () => {
    renderEditor({
      all: [{ field: "kind", op: "eq", value: "BOOK" }, { any: [] }],
    });

    const all = screen.getByRole("group", {
      name: "Match all of 2 conditions",
    });
    expect(
      within(all).getByRole("group", { name: "Match any conditions" }),
    ).toBeInTheDocument();
    await userEvent.setup().click(
      within(all).getByRole("button", { name: "Condition 2 actions" }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Negate condition" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Remove condition" }),
    ).toBeInTheDocument();
  });

  it("reorders sibling rules with keyboard-operable controls", async () => {
    const user = userEvent.setup();
    const original: BaseFilter = {
      all: [
        { field: "kind", op: "eq", value: "BOOK" },
        { field: "status", op: "eq", value: "reading" },
      ],
    };
    const { onChange } = renderEditor(original);
    const all = screen.getByRole("group", {
      name: "Match all of 2 conditions",
    });
    // Opening from the keyboard lands on the first enabled item, Move up.
    within(all).getByRole("button", { name: "Condition 2 actions" }).focus();
    await user.keyboard("{Enter}");
    await user.keyboard("{Enter}");

    expect(latest(onChange)).toEqual({
      all: [
        { field: "status", op: "eq", value: "reading" },
        { field: "kind", op: "eq", value: "BOOK" },
      ],
    });
    expect(original).toEqual({
      all: [
        { field: "kind", op: "eq", value: "BOOK" },
        { field: "status", op: "eq", value: "reading" },
      ],
    });
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

    await chooseMenuAction(
      user,
      "Condition 1 actions",
      "Remove condition",
      screen.getByRole("group", { name: "Match all of 2 conditions" }),
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

    await chooseMenuAction(
      user,
      "Condition 1 actions",
      "Remove condition",
      screen.getByRole("group", { name: "Match any of 1 condition" }),
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
    await user.click(
      screen.getByRole("button", {
        name: /edit condition 1 as an advanced condition/i,
      }),
    );
    const field = screen.getByRole("button", { name: selectTriggerName("Field for condition 1") });
    await user.click(field);
    expect(await screen.findByRole("option", { name: "ID" })).toBeInTheDocument();
    expect(screen.getByText("Page fields")).toBeInTheDocument();
    expect(screen.getByText("Declared properties")).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const operator = screen.getByRole("button", { name: selectTriggerName("Operator for condition 1") });
    await user.click(operator);
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["contains", "in", "is empty", "not empty"]);
    await user.click(screen.getByRole("option", { name: "is empty" }));
    expect(latest(onChange)).toEqual({ field: "tags", op: "is_empty" });
    expect(screen.queryByLabelText("Value for condition 1")).toBeNull();

    await chooseSelectOption(user, "Field for condition 1", "source");
    await user.click(
      screen.getByRole("button", { name: selectTriggerName("Operator for condition 1") }),
    );
    expect(
      screen.getAllByRole("option").map((option) => option.textContent),
    ).toEqual(["eq", "ne", "links to", "is empty", "not empty"]);
  });

  it("uses declared option, boolean, numeric, and relation value affordances", async () => {
    const user = userEvent.setup();
    renderEditor({ field: "status", op: "eq", value: "queued" });

    expect(
      screen.getByRole("button", { name: selectTriggerName("Value for condition 1") }),
    ).toHaveTextContent("queued");

    await chooseSelectOption(user, "Field for condition 1", "published");
    expect(
      screen.getByRole("button", { name: selectTriggerName("Value for condition 1") }),
    ).toHaveTextContent("True");

    await chooseSelectOption(user, "Field for condition 1", "rating");
    expect(screen.getByLabelText("Value for condition 1")).toHaveAttribute(
      "type",
      "number",
    );

    await chooseSelectOption(user, "Field for condition 1", "source");
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

    await chooseSelectOption(user, "Operator for condition 1", "in");
    const boolValues = screen.getByRole("button", { name: selectTriggerName("Value for condition 1") });
    await user.click(boolValues);
    expect(await screen.findByRole("listbox")).toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "False" }));
    expect(latest(onChange)).toEqual({
      field: "published",
      op: "in",
      value: [true, false],
    });

    await user.keyboard("{Escape}");
    await chooseSelectOption(user, "Field for condition 1", "Title");
    await chooseSelectOption(user, "Operator for condition 1", "in");
    const freeform = screen.getByLabelText("Value for condition 1");
    await user.clear(freeform);
    await user.type(freeform, "alpha, beta");
    expect(freeform).toHaveValue("alpha, beta");
    expect(latest(onChange)).toEqual({
      field: "title",
      op: "in",
      value: [],
    });
    await user.keyboard("{Enter}");
    expect(latest(onChange)).toEqual({
      field: "title",
      op: "in",
      value: ["alpha", "beta"],
    });
  });

  it("keeps unsupported wire fields, operators, and option values visible", async () => {
    const user = userEvent.setup();
    const view = renderEditor({
      field: "prop.legacy_relation",
      op: "links_to",
      value: "Old Page",
    });

    const field = screen.getByRole("button", { name: selectTriggerName("Field for condition 1") });
    expect(field).toHaveTextContent("prop.legacy_relation (undeclared)");
    await user.click(field);
    expect(
      await screen.findByRole("option", {
        name: "prop.legacy_relation (undeclared)",
      }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");

    const operator = screen.getByRole("button", { name: selectTriggerName("Operator for condition 1") });
    expect(operator).toHaveTextContent("links_to (unsupported)");
    await user.click(operator);
    expect(
      await screen.findByRole("option", { name: "links_to (unsupported)" }),
    ).toBeInTheDocument();

    view.unmount();
    const removedOption = renderEditor({
      field: "status",
      op: "eq",
      value: "retired",
    });
    const removedValue = screen.getByRole("button", { name: selectTriggerName("Value for condition 1") });
    expect(removedValue).toHaveTextContent("retired (not declared)");
    await user.click(removedValue);
    expect(
      await screen.findByRole("option", { name: "retired (not declared)" }),
    ).toBeInTheDocument();

    removedOption.unmount();
    renderEditor({
      field: "topics",
      op: "in",
      value: ["craft", "lost", "other"],
    });
    await user.click(
      screen.getByRole("button", { name: selectTriggerName("Value for condition 1") }),
    );
    const lost = await screen.findByRole("option", {
      name: "lost (not declared)",
    });
    const other = screen.getByRole("option", {
      name: "other (not declared)",
    });
    expect(lost).toHaveAttribute("aria-selected", "true");
    expect(other).toHaveAttribute("aria-selected", "true");
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
    expect(screen.getByRole("button", { name: "Add rule" })).toHaveFocus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("menuitem", { name: "Condition" }));
    expect(latest(onChange)).toEqual({ field: "kind", op: "eq", value: "" });
    expect(screen.getByLabelText("Field for condition 1")).toBeInTheDocument();
  });

  it("submits the membership rule edited during guided creation", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue({ slug: "books" });
    render(<CreateBaseDialog isOpen onClose={vi.fn()} onCreate={onCreate} />);

    await user.type(screen.getByLabelText("Name"), "Books");
    await chooseMenuAction(user, "Add rule", "Condition");
    await chooseSelectOption(user, "Field for condition 1", "Kind");
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

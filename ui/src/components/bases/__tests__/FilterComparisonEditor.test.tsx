import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BaseFilter } from "#/api/bases";
import type { DraftProperty } from "#/components/bases/definition-model";
import { FilterComparisonEditor } from "#/components/bases/FilterComparisonEditor";
import { createFilterDiagnosticScope } from "#/components/bases/filter-diagnostics";

vi.mock("#/api/pages", () => ({
  usePages: () => ({
    data: {
      items: [
        {
          id: "0190f8a0-0000-7000-8000-000000000001",
          title: "Jerry",
          canonical_name: "jerry",
          path: "people/jerry-one.md",
          kind: "PERSON",
          aliases: [],
          project: "orphan-project",
        },
        {
          id: "0190f8a0-0000-7000-8000-000000000002",
          title: "Jerry",
          canonical_name: "jerry",
          path: "people/jerry-two.md",
          kind: "PERSON",
          aliases: [],
          project: null,
        },
      ],
    },
  }),
}));

function selectTriggerName(label: string) {
  return new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
}

async function chooseSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  option: string,
) {
  const trigger = screen.getByRole("button", {
    name: selectTriggerName(label),
  });
  await user.click(trigger);
  await user.click(await screen.findByRole("option", { name: option }));
}

const properties: DraftProperty[] = [
  { id: "started-property", key: "started", definition: { type: "date" } },
  { id: "note-property", key: "note", definition: { type: "text" } },
];

function Harness({
  initial,
  onChange,
  allowAttendees = true,
  declaredProperties = properties,
}: {
  initial: BaseFilter;
  onChange(value: BaseFilter): void;
  allowAttendees?: boolean;
  declaredProperties?: DraftProperty[];
}) {
  const [value, setValue] = useState(initial);
  const scope = createFilterDiagnosticScope({
    root: "filter",
    path: [],
    diagnostics: [],
  });
  return (
    <FilterComparisonEditor
      value={value}
      position={1}
      properties={declaredProperties}
      allowAttendees={allowAttendees}
      onChange={(next) => {
        setValue(next);
        onChange(next);
      }}
      diagnosticScope={scope}
    />
  );
}

function renderComparison(initial: BaseFilter) {
  const onChange = vi.fn();
  render(<Harness initial={initial} onChange={onChange} />);
  return { onChange };
}

describe("FilterComparisonEditor", () => {
  it("emits a valueless comparison and hides the value input for a relative-date operator", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComparison({
      field: "started",
      op: "eq",
      value: "2026-08-01",
    });

    await chooseSelectOption(user, "Operator for condition 1", "is today");

    expect(onChange).toHaveBeenLastCalledWith({
      field: "started",
      op: "is_today",
    });
    expect(onChange.mock.calls.at(-1)?.[0]).not.toHaveProperty("value");
    expect(
      screen.queryByLabelText("Value for condition 1"),
    ).not.toBeInTheDocument();
  });

  it("keeps the text value input for an affix operator", async () => {
    const user = userEvent.setup();
    renderComparison({ field: "note", op: "eq", value: "" });

    await chooseSelectOption(user, "Operator for condition 1", "starts with");

    expect(screen.getByLabelText("Value for condition 1")).toBeInTheDocument();
  });

  it("commits human-labelled kinds only after a choice, never typed arbitrary values", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComparison({
      field: "kind",
      op: "eq",
      value: "",
    });
    const input = screen.getByRole("combobox", {
      name: "Value for condition 1",
    });
    expect(input).toHaveValue("");
    await user.type(input, "invented-kind{Enter}");
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue("");

    await user.type(input, "Meet");
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole("option", { name: "Meeting" }));
    expect(onChange).toHaveBeenLastCalledWith({
      field: "kind",
      op: "eq",
      value: "MEETING",
    });
  });

  it("supports multi-choice kinds including Quote and removes a selected value", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComparison({
      field: "kind",
      op: "in",
      value: [],
    });
    const input = screen.getByRole("combobox", {
      name: "Value for condition 1",
    });
    await user.type(input, "Meet");
    await user.click(screen.getByRole("option", { name: "Meeting" }));
    await user.clear(input);
    await user.type(input, "Quote");
    await user.click(screen.getByRole("option", { name: "Quote" }));
    expect(onChange).toHaveBeenLastCalledWith({
      field: "kind",
      op: "in",
      value: ["MEETING", "QUOTE"],
    });
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Remove Meeting" }));
    expect(onChange).toHaveBeenLastCalledWith({
      field: "kind",
      op: "in",
      value: ["QUOTE"],
    });
  });

  it("keeps orphan project values available without allowing project creation", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComparison({
      field: "project",
      op: "eq",
      value: "",
    });
    const input = screen.getByRole("combobox", {
      name: "Value for condition 1",
    });
    await user.type(input, "new-project{Enter}");
    await user.tab();
    expect(onChange).not.toHaveBeenCalled();
    await user.type(input, "orphan");
    await user.click(screen.getByRole("option", { name: "orphan-project" }));
    expect(onChange).toHaveBeenLastCalledWith({
      field: "project",
      op: "eq",
      value: "orphan-project",
    });
  });

  it("authors attendee membership using the selected person's identity, not a duplicate title", async () => {
    const user = userEvent.setup();
    const { onChange } = renderComparison({
      field: "kind",
      op: "eq",
      value: "",
    });
    await chooseSelectOption(user, "Field for condition 1", "Attendees");
    expect(onChange).toHaveBeenLastCalledWith({
      field: "attendees",
      op: "links_to",
      value: "",
    });
    onChange.mockClear();
    const input = screen.getByRole("combobox", {
      name: "Value for condition 1",
    });
    await user.type(input, "Jerry");
    expect(onChange).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("option", { name: /people\/jerry-two\.md/ }),
    );
    expect(onChange).toHaveBeenLastCalledWith({
      field: "attendees",
      op: "links_to",
      value: "0190f8a0-0000-7000-8000-000000000002",
    });
  });

  it("preserves legacy kinds and unsupported operators until the author changes them", () => {
    const { onChange } = renderComparison({
      field: "kind",
      op: "contains",
      value: "OLD_KIND",
    });
    expect(
      screen.getByRole("combobox", { name: "Value for condition 1" }),
    ).toHaveValue("OLD_KIND (not in current list)");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("hides only undeclared attendees when declaration is unavailable", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ field: "kind", op: "eq", value: "" }}
        allowAttendees={false}
        onChange={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole("button", { name: /Field for condition 1/ }),
    );
    expect(
      screen.queryByRole("option", { name: "Attendees" }),
    ).not.toBeInTheDocument();
  });

  it("respects an explicitly declared non-relation attendee type", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <Harness
        initial={{ field: "kind", op: "eq", value: "" }}
        declaredProperties={[
          { id: "attendees", key: "attendees", definition: { type: "number" } },
        ]}
        allowAttendees={false}
        onChange={onChange}
      />,
    );
    await chooseSelectOption(user, "Field for condition 1", "Attendees");
    await user.type(
      screen.getByRole("spinbutton", { name: "Value for condition 1" }),
      "2",
    );
    expect(onChange).toHaveBeenLastCalledWith({
      field: "attendees",
      op: "eq",
      value: 2,
    });
  });

  it.each<{ next: BaseFilter; expected: string }>([
    {
      next: { field: "title", op: "eq", value: "new field" },
      expected: "new field",
    },
    {
      next: { field: "note", op: "in", value: ["new operator"] },
      expected: "new operator",
    },
  ])(
    "discards a stale freeform draft after a controlled field/operator change",
    async ({ next, expected }) => {
      const user = userEvent.setup();
      const props = {
        position: 1,
        properties,
        onChange: vi.fn(),
        diagnosticScope: createFilterDiagnosticScope({
          root: "filter",
          path: [],
          diagnostics: [],
        }),
      };
      const { rerender } = render(
        <FilterComparisonEditor
          {...props}
          value={{ field: "note", op: "eq", value: "" }}
        />,
      );
      await user.type(
        screen.getByRole("textbox", { name: "Value for condition 1" }),
        "old draft",
      );
      rerender(<FilterComparisonEditor {...props} value={next} />);
      expect(
        screen.getByRole("textbox", { name: "Value for condition 1" }),
      ).toHaveValue(expected);
    },
  );
});

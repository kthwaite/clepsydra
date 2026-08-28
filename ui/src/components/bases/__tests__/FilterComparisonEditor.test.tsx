import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { BaseFilter } from "#/api/bases";
import type { DraftProperty } from "#/components/bases/definition-model";
import { FilterComparisonEditor } from "#/components/bases/FilterComparisonEditor";
import { createFilterDiagnosticScope } from "#/components/bases/filter-diagnostics";

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

/** A controlled harness: `FilterComparisonEditor` is a pure controlled
 * component with no internal state, so the test must feed each `onChange`
 * back in as the next `value` prop to observe the resulting render. */
function Harness({
  initial,
  onChange,
}: {
  initial: BaseFilter;
  onChange(value: BaseFilter): void;
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
      properties={properties}
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
});

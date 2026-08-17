import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import {
  EMPTY_FILTER_STATE,
  type FilterField,
  type FilterState,
} from "#/lib/filters/model";
import { FilterBar } from "./FilterBar";

const FIELDS: FilterField[] = [
  {
    id: "project",
    kind: "single",
    label: "PROJECT",
    options: [{ value: "clepsydra" }, { value: "xxii" }],
  },
  {
    id: "tags",
    kind: "multi",
    label: "TAG",
    options: [{ value: "rust" }, { value: "ui" }],
  },
  { id: "hold", kind: "flag", label: "ON HOLD", options: [] },
];

function Harness({ initial = EMPTY_FILTER_STATE }: { initial?: FilterState }) {
  const [state, setState] = useState(initial);
  return (
    <FilterBar
      fields={FIELDS}
      state={state}
      onChange={setState}
      filteredCount={3}
      totalCount={9}
    />
  );
}

describe("FilterBar", () => {
  it("adds a multi facet value through the popover and shows a chip", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-tags"));
    await user.click(screen.getByTestId("filter-bar-option-tags-rust"));
    expect(screen.getByTestId("filter-bar-chip-tags-rust")).toHaveTextContent(
      "TAG: rust",
    );
    // multi keeps the popover open for further toggles
    expect(screen.getByTestId("filter-bar-option-tags-ui")).toBeInTheDocument();
  });

  it("closes the popover after a single-field selection", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-project"));
    await user.click(screen.getByTestId("filter-bar-option-project-xxii"));
    expect(
      screen.getByTestId("filter-bar-chip-project-xxii"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("filter-bar-option-project-clepsydra"),
    ).not.toBeInTheDocument();
  });

  it("toggles flag fields directly from the field list", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-hold"));
    const chip = screen.getByTestId("filter-bar-chip-hold-1");
    expect(chip).toHaveTextContent("ON HOLD");
    expect(chip).not.toHaveTextContent(":");
  });

  it("removes a facet value when its chip is clicked", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ text: "", facets: { tags: ["rust"] } }} />);
    await user.click(screen.getByTestId("filter-bar-chip-tags-rust"));
    expect(
      screen.queryByTestId("filter-bar-chip-tags-rust"),
    ).not.toBeInTheDocument();
  });

  it("clears everything via CLEAR and hides it when inactive", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ text: "x", facets: { tags: ["ui"] } }} />);
    await user.click(screen.getByTestId("filter-bar-clear"));
    expect(
      screen.queryByTestId("filter-bar-chip-tags-ui"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-input")).toHaveValue("");
    expect(screen.queryByTestId("filter-bar-clear")).not.toBeInTheDocument();
  });

  it("shows the count only while active", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(screen.queryByTestId("filter-bar-count")).not.toBeInTheDocument();
    await user.type(screen.getByTestId("filter-bar-input"), "abc");
    expect(screen.getByTestId("filter-bar-count")).toHaveTextContent(
      "03 OF 09",
    );
  });

  it("Escape clears and blurs the text input without propagating", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByTestId("filter-bar-input");
    await user.type(input, "abc");
    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
  });

  it("filters long option lists through the option filter input", async () => {
    const user = userEvent.setup();
    const many: FilterField[] = [
      {
        id: "tags",
        kind: "multi",
        label: "TAG",
        options: Array.from({ length: 12 }, (_, i) => ({ value: `tag-${i}` })),
      },
    ];
    function ManyHarness() {
      const [state, setState] = useState(EMPTY_FILTER_STATE);
      return <FilterBar fields={many} state={state} onChange={setState} />;
    }
    render(<ManyHarness />);
    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByTestId("filter-bar-field-tags"));
    const optionFilter = screen.getByTestId("filter-bar-option-filter");
    await user.type(optionFilter, "tag-1");
    expect(
      screen.getByTestId("filter-bar-option-tags-tag-1"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("filter-bar-option-tags-tag-11"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("filter-bar-option-tags-tag-2"),
    ).not.toBeInTheDocument();
  });

  it("hides the text input when showText is false", () => {
    render(
      <FilterBar
        fields={FIELDS}
        state={EMPTY_FILTER_STATE}
        onChange={() => {}}
        showText={false}
      />,
    );
    expect(screen.queryByTestId("filter-bar-input")).not.toBeInTheDocument();
  });
});

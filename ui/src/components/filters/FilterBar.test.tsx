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
    options: [
      { value: "clepsydra", label: "Clepsydra" },
      { value: "xxii", label: "XXII" },
    ],
  },
  {
    id: "tags",
    kind: "multi",
    label: "TAG",
    options: [
      { value: "rust", label: "Rust" },
      { value: "ui", label: "Interface" },
      { value: "docs", label: "Docs" },
    ],
  },
  { id: "hold", kind: "flag", label: "ON HOLD", options: [] },
  {
    id: "owner",
    kind: "multi",
    label: "OWNER",
    options: Array.from({ length: 12 }, (_, index) => ({
      value: `person-${index}`,
      label: `Person ${index}`,
    })),
  },
  {
    id: "status",
    kind: "multi",
    label: "STATUS",
    options: [
      { value: "open", label: "Open" },
      { value: "closed", label: "Closed" },
    ],
  },
];

interface HarnessProps {
  initial?: FilterState;
  fields?: readonly FilterField[];
  primaryFieldIds?: readonly string[];
  showText?: boolean;
}

function Harness({
  initial = EMPTY_FILTER_STATE,
  fields = FIELDS,
  primaryFieldIds = ["project", "tags", "hold"],
  showText,
}: HarnessProps) {
  const [state, setState] = useState(initial);
  return (
    <FilterBar
      fields={fields}
      state={state}
      onChange={setState}
      primaryFieldIds={primaryFieldIds}
      showText={showText}
      filteredCount={3}
      totalCount={9}
    />
  );
}

describe("FilterBar", () => {
  it("always shows the configured primary field chips", () => {
    render(<Harness />);

    expect(screen.getByTestId("filter-bar-chip-project")).toHaveTextContent(
      "PROJECT",
    );
    expect(screen.getByTestId("filter-bar-chip-tags")).toHaveTextContent("TAG");
    expect(screen.getByTestId("filter-bar-chip-hold")).toHaveTextContent(
      "ON HOLD",
    );
    expect(screen.queryByTestId("filter-bar-chip-owner")).not.toBeInTheDocument();
  });

  it("uses the first three fields as primary chips when no mapping is supplied", () => {
    render(
      <FilterBar
        fields={FIELDS}
        state={EMPTY_FILTER_STATE}
        onChange={() => {}}
      />,
    );

    expect(screen.getByTestId("filter-bar-chip-project")).toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-chip-tags")).toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-chip-hold")).toBeInTheDocument();
    expect(screen.queryByTestId("filter-bar-chip-owner")).not.toBeInTheDocument();
  });

  it("shows a resolved option label for one value and a selected-value count for several", () => {
    const { unmount } = render(
      <Harness
        initial={{ text: "", facets: { project: ["clepsydra"] } }}
      />,
    );

    expect(screen.getByTestId("filter-bar-chip-project")).toHaveTextContent(
      "PROJECT: Clepsydra",
    );

    unmount();
    render(
      <Harness initial={{ text: "", facets: { tags: ["rust", "ui"] } }} />,
    );
    expect(screen.getByTestId("filter-bar-chip-tags")).toHaveTextContent(
      "TAG · 2",
    );
    expect(screen.getByTestId("filter-bar-chip-tags")).not.toHaveTextContent(
      "Interface",
    );
  });

  it("opens a primary chip's single option pane without clearing its value", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ text: "", facets: { project: ["clepsydra"] } }}
      />,
    );

    await user.click(screen.getByTestId("filter-bar-chip-project"));

    expect(screen.getByRole("dialog", { name: "PROJECT options" })).toBeVisible();
    expect(screen.queryByText("← FIELDS")).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Clepsydra" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByTestId("filter-bar-chip-project")).toHaveTextContent(
      "PROJECT: Clepsydra",
    );
  });

  it("clears one field through a separate control without touching another", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          text: "",
          facets: { project: ["clepsydra"], tags: ["rust"] },
        }}
      />,
    );

    const clearProject = screen.getByRole("button", {
      name: "Clear PROJECT filter",
    });
    expect(clearProject).not.toBe(screen.getByTestId("filter-bar-chip-project"));
    await user.click(clearProject);

    expect(screen.getByTestId("filter-bar-chip-project")).toHaveTextContent(
      "PROJECT",
    );
    expect(
      screen.queryByRole("button", { name: "Clear PROJECT filter" }),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-chip-tags")).toHaveTextContent(
      "TAG: Rust",
    );
  });

  it("moves focus from a primary clear control to its surviving chip", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ text: "", facets: { project: ["clepsydra"] } }}
      />,
    );

    screen.getByRole("button", { name: "Clear PROJECT filter" }).focus();
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("filter-bar-chip-project")).toHaveFocus();
  });

  it("moves focus from a long-tail clear control to + FILTER", async () => {
    const user = userEvent.setup();
    render(
      <Harness initial={{ text: "", facets: { status: ["open"] } }} />,
    );

    screen.getByRole("button", { name: "Clear STATUS filter" }).focus();
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("filter-bar-add")).toHaveFocus();
    expect(screen.queryByTestId("filter-bar-chip-status")).not.toBeInTheDocument();
  });

  it("selects options in one pane and closes only single-value panes", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId("filter-bar-chip-tags"));
    await user.click(screen.getByRole("option", { name: "Rust" }));
    expect(screen.getByTestId("filter-bar-chip-tags")).toHaveTextContent(
      "TAG: Rust",
    );
    expect(screen.getByRole("dialog", { name: "TAG options" })).toBeVisible();

    await user.keyboard("{Escape}");
    await user.click(screen.getByTestId("filter-bar-chip-project"));
    await user.click(screen.getByRole("option", { name: "XXII" }));
    expect(screen.getByTestId("filter-bar-chip-project")).toHaveTextContent(
      "PROJECT: XXII",
    );
    expect(
      screen.queryByRole("dialog", { name: "PROJECT options" }),
    ).not.toBeInTheDocument();
  });

  it("filters a long option pane by resolved label", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId("filter-bar-add"));
    await user.click(screen.getByRole("option", { name: "OWNER" }));
    const filter = screen.getByRole("searchbox", {
      name: "Filter OWNER options",
    });
    await user.type(filter, "Person 1");

    expect(screen.getByRole("option", { name: "Person 1" })).toBeVisible();
    expect(screen.getByRole("option", { name: "Person 11" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "Person 2" }),
    ).not.toBeInTheDocument();
  });

  it("toggles the focused option with Enter and closes on Escape without another change", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId("filter-bar-chip-tags"));
    const rust = screen.getByRole("option", { name: "Rust" });
    rust.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByTestId("filter-bar-chip-tags")).toHaveTextContent(
      "TAG: Rust",
    );

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "TAG options" })).not.toBeInTheDocument();
    expect(screen.getByTestId("filter-bar-chip-tags")).toHaveTextContent(
      "TAG: Rust",
    );
  });

  it("promotes a long-tail field from + FILTER while active and removes it when cleared", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByTestId("filter-bar-add"));
    expect(screen.getByRole("option", { name: "OWNER" })).toBeVisible();
    expect(screen.getByRole("option", { name: "STATUS" })).toBeVisible();
    expect(
      screen.queryByRole("option", { name: "PROJECT" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("option", { name: "STATUS" }));
    expect(screen.getByTestId("filter-bar-chip-status")).toHaveTextContent(
      "STATUS",
    );
    expect(screen.getByRole("dialog", { name: "STATUS options" })).toBeVisible();
    await user.click(screen.getByRole("option", { name: "Open" }));
    await user.keyboard("{Escape}");

    await user.click(screen.getByTestId("filter-bar-add"));
    expect(
      screen.queryByRole("option", { name: "STATUS" }),
    ).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(
      screen.getByRole("button", { name: "Clear STATUS filter" }),
    );
    expect(screen.queryByTestId("filter-bar-chip-status")).not.toBeInTheDocument();
  });

  it("toggles flag chips directly and exposes their selected state", async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const hold = screen.getByTestId("filter-bar-chip-hold");
    expect(hold).toHaveAttribute("aria-pressed", "false");
    await user.click(hold);
    expect(hold).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("dialog", { name: "ON HOLD options" })).not.toBeInTheDocument();
    await user.click(hold);
    expect(hold).toHaveAttribute("aria-pressed", "false");
  });

  it("clears text and every facet globally while keeping inactive primary chips", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{
          text: "needle",
          facets: { tags: ["rust"], status: ["open"] },
        }}
      />,
    );

    await user.click(screen.getByTestId("filter-bar-clear"));

    expect(screen.getByTestId("filter-bar-input")).toHaveValue("");
    expect(screen.getByTestId("filter-bar-chip-tags")).toHaveTextContent("TAG");
    expect(screen.queryByTestId("filter-bar-chip-status")).not.toBeInTheDocument();
    expect(screen.queryByTestId("filter-bar-clear")).not.toBeInTheDocument();
  });

  it("moves focus from global CLEAR to the text input", async () => {
    const user = userEvent.setup();
    render(<Harness initial={{ text: "needle", facets: {} }} />);

    screen.getByTestId("filter-bar-clear").focus();
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("filter-bar-input")).toHaveFocus();
  });

  it("moves focus from global CLEAR to the first primary chip without text search", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        initial={{ text: "", facets: { tags: ["rust"] } }}
        showText={false}
      />,
    );

    screen.getByTestId("filter-bar-clear").focus();
    await user.keyboard("{Enter}");

    expect(screen.getByTestId("filter-bar-chip-project")).toHaveFocus();
  });

  it("keeps text search, Escape clearing, and active result count behavior", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const input = screen.getByRole("textbox", { name: "Filter" });

    expect(screen.queryByTestId("filter-bar-count")).not.toBeInTheDocument();
    await user.type(input, "abc");
    expect(input).toHaveValue("abc");
    expect(screen.getByTestId("filter-bar-count")).toHaveTextContent("03 OF 09");

    await user.keyboard("{Escape}");
    expect(input).toHaveValue("");
    expect(input).not.toHaveFocus();
    expect(screen.queryByTestId("filter-bar-count")).not.toBeInTheDocument();
  });

  it("supports text-field visibility and accessible-name overrides", () => {
    const { rerender } = render(<Harness showText={false} />);
    expect(screen.queryByTestId("filter-bar-input")).not.toBeInTheDocument();

    rerender(
      <FilterBar
        fields={FIELDS}
        state={EMPTY_FILTER_STATE}
        onChange={() => {}}
        textAriaLabel="Search pages"
      />,
    );
    expect(screen.getByRole("textbox", { name: "Search pages" })).toBeVisible();
  });
});

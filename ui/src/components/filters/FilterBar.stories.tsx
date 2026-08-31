import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { FilterField, FilterState } from "#/lib/filters/model";
import { FilterBar } from "./FilterBar";

const FIELDS = [
  {
    id: "project",
    kind: "single",
    label: "PROJECT",
    options: [
      { value: "atlas", label: "Atlas" },
      { value: "clepsydra", label: "Clepsydra" },
    ],
  },
  {
    id: "status",
    kind: "single",
    label: "STATUS",
    options: [
      { value: "inbox", label: "Inbox" },
      { value: "active", label: "In Progress" },
      { value: "done", label: "Done" },
    ],
  },
  {
    id: "tags",
    kind: "multi",
    label: "TAG",
    options: [
      { value: "reading" },
      { value: "research" },
      { value: "urgent" },
    ],
  },
  {
    id: "year",
    kind: "single",
    label: "YEAR",
    options: [
      { value: "2026" },
      { value: "2025" },
      { value: "2024" },
    ],
  },
] satisfies readonly FilterField[];

const PRIMARY_FIELD_IDS = ["project", "status", "tags"] as const;

interface ControlledFilterBarProps {
  initialState: FilterState;
  mobileWidth?: boolean;
}

function ControlledFilterBar({
  initialState,
  mobileWidth = false,
}: ControlledFilterBarProps) {
  const [state, setState] = useState(initialState);
  const filterBar = (
    <FilterBar
      fields={FIELDS}
      primaryFieldIds={PRIMARY_FIELD_IDS}
      state={state}
      onChange={setState}
      textPlaceholder="Filter pages…"
      filteredCount={7}
      totalCount={12}
      className="flex-wrap"
    />
  );

  return mobileWidth ? (
    <div style={{ width: 320, maxWidth: "100%" }}>{filterBar}</div>
  ) : (
    filterBar
  );
}

const meta = {
  title: "Filters/FilterBar",
  component: FilterBar,
  parameters: {
    layout: "padded",
  },
} satisfies Meta<typeof FilterBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const InactivePrimaryChips: Story = {
  render: () => (
    <ControlledFilterBar initialState={{ text: "", facets: {} }} />
  ),
};

export const SingleSelection: Story = {
  render: () => (
    <ControlledFilterBar
      initialState={{ text: "", facets: { project: ["atlas"] } }}
    />
  ),
};

export const MultipleSelections: Story = {
  render: () => (
    <ControlledFilterBar
      initialState={{ text: "", facets: { tags: ["reading", "urgent"] } }}
    />
  ),
};

export const PromotedLongTailFacet: Story = {
  render: () => (
    <ControlledFilterBar
      initialState={{ text: "", facets: { year: ["2026"] } }}
    />
  ),
};

export const MobileWidthWrapping: Story = {
  render: () => (
    <ControlledFilterBar
      initialState={{
        text: "",
        facets: {
          project: ["clepsydra"],
          tags: ["reading", "research"],
          year: ["2026"],
        },
      }}
      mobileWidth
    />
  ),
};

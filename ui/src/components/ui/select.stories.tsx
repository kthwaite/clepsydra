import { useState } from "react";
import type { Key } from "react-aria-components/Select";
import type { Meta, StoryObj } from "@storybook/react";
import { Select, SelectItem } from "#/components/ui/select";

const meta: Meta<typeof Select> = {
  title: "UI/Select",
  component: Select,
};

export default meta;

type Story = StoryObj<typeof meta>;
const options = [
  { id: "draft", name: "Draft" },
  { id: "in-progress", name: "In progress" },
  { id: "done", name: "Done" },
];

function ControlledExample() {
  const [value, setValue] = useState<Key | null>("draft");

  return (
    <Select label="Status" value={value} onChange={setValue}>
      <SelectItem id="draft">Draft</SelectItem>
      <SelectItem id="in-progress">In progress</SelectItem>
      <SelectItem id="done">Done</SelectItem>
    </Select>
  );
}

export const Default: Story = {
  render: () => (
    <Select label="Status">
      <SelectItem id="draft">Draft</SelectItem>
      <SelectItem id="in-progress">In progress</SelectItem>
      <SelectItem id="done">Done</SelectItem>
    </Select>
  ),
};

export const Placeholder: Story = {
  render: () => (
    <Select label="Status" placeholder="Choose status">
      <SelectItem id="draft">Draft</SelectItem>
      <SelectItem id="in-progress">In progress</SelectItem>
      <SelectItem id="done">Done</SelectItem>
    </Select>
  ),
};

export const WithDefaultValue: Story = {
  render: () => (
    <Select label="Status" defaultValue="in-progress">
      <SelectItem id="draft">Draft</SelectItem>
      <SelectItem id="in-progress">In progress</SelectItem>
      <SelectItem id="done">Done</SelectItem>
    </Select>
  ),
};

export const Controlled: Story = {
  render: () => <ControlledExample />,
};

export const Disabled: Story = {
  render: () => (
    <Select label="Status" value="draft" isDisabled>
      <SelectItem id="draft">Draft</SelectItem>
      <SelectItem id="in-progress">In progress</SelectItem>
      <SelectItem id="done">Done</SelectItem>
    </Select>
  ),
};

export const Invalid: Story = {
  render: () => (
    <Select
      label="Status"
      description="Choose the current workflow state"
      isInvalid
      errorMessage="A status is required"
    >
      <SelectItem id="draft">Draft</SelectItem>
      <SelectItem id="in-progress">In progress</SelectItem>
      <SelectItem id="done">Done</SelectItem>
    </Select>
  ),
};

export const LongOptions: Story = {
  render: () => (
    <div className="w-64">
      <Select label="Workspace" placeholder="Choose a workspace">
        <SelectItem id="personal">
          Personal notes and reference material
        </SelectItem>
        <SelectItem id="research">
          Research archive with a deliberately long descriptive name
        </SelectItem>
        <SelectItem id="shared">
          Shared team knowledge base for active projects
        </SelectItem>
      </Select>
    </div>
  ),
};

export const DynamicItems: Story = {
  render: () => (
    <Select label="Status" items={options} placeholder="Choose status">
      {(item) => <SelectItem id={item.id}>{item.name}</SelectItem>}
    </Select>
  ),
};

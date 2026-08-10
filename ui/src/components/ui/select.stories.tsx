import type { Meta, StoryObj } from "@storybook/react";
import { Select, SelectItem } from "#/components/ui/select";

const meta: Meta<typeof Select> = {
  title: "UI/Select",
  component: Select,
};

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <>
      <Select label="Select an option">
        <SelectItem>Option 1</SelectItem>
        <SelectItem>Option 2</SelectItem>
        <SelectItem>Option 3</SelectItem>
      </Select>
    </>
  ),
};

export const WithDefaultValue: Story = {
  render: () => (
    <>
      <Select label="Select an option" defaultValue="option1">
        <SelectItem id="option1">Option 1</SelectItem>
        <SelectItem>Option 2</SelectItem>
        <SelectItem>Option 3</SelectItem>
      </Select>
    </>
  ),
};

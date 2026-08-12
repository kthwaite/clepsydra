import type { Meta, StoryObj } from "@storybook/react";
import { Checkbox } from "#/components/ui/checkbox";

const meta: Meta<typeof Checkbox> = {
  title: "UI/Checkbox",
  component: Checkbox,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: "Encrypt note",
  },
};

export const Selected: Story = {
  args: {
    children: "Encrypt note",
    defaultSelected: true,
  },
};

export const Indeterminate: Story = {
  args: {
    children: "Encrypt note",
    isIndeterminate: true,
  },
};

export const WithDescription: Story = {
  args: {
    children: "Encrypt note",
    description: "Stored locally",
  },
};

export const Disabled: Story = {
  args: {
    children: "Encrypt note",
    isDisabled: true,
  },
};

export const Invalid: Story = {
  args: {
    children: "Encrypt note",
    isInvalid: true,
    errorMessage: "Required",
  },
};

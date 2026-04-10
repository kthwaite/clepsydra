import type { Meta, StoryObj } from "@storybook/react";
import { TaskStatusButton } from "#/components/ui/task-status-button";

const meta: Meta<typeof TaskStatusButton> = {
  title: "UI/TaskStatusButton",
  component: TaskStatusButton,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Todo: Story = {
  args: { status: "todo", onToggle: () => {} },
};

export const Doing: Story = {
  args: { status: "doing", onToggle: () => {} },
};

export const Done: Story = {
  args: { status: "done", onToggle: () => {} },
};

export const Cancelled: Story = {
  args: { status: "cancelled", onToggle: () => {} },
};

export const Disabled: Story = {
  args: { status: "todo", onToggle: () => {}, isDisabled: true },
};

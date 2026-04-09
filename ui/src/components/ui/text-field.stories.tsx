import type { Meta, StoryObj } from "@storybook/react";
import { TextField } from "#/components/ui/text-field";

const meta: Meta<typeof TextField> = {
  title: "UI/TextField",
  component: TextField,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { label: "Path", placeholder: "notes/new-note.md" },
};

export const WithDescription: Story = {
  args: {
    label: "Path",
    placeholder: "notes/new-note.md",
    description: "Example: notes/hello.md",
  },
};

export const WithError: Story = {
  args: {
    label: "Path",
    isInvalid: true,
    errorMessage: "Path is required.",
  },
};

export const Disabled: Story = {
  args: { label: "Path", isDisabled: true, value: "locked-path.md" },
};

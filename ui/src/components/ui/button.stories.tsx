import type { Meta, StoryObj } from "@storybook/react";
import { ChevronLeft, Settings } from "lucide-react";
import { Button } from "#/components/ui/button";

const meta: Meta<typeof Button> = {
  title: "UI/Button",
  component: Button,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { variant: "primary", children: "Create Note" },
};

export const Secondary: Story = {
  args: { variant: "secondary", children: "Cancel" },
};

export const Ghost: Story = {
  args: { variant: "ghost", children: "Settings" },
};

export const Danger: Story = {
  args: { variant: "danger", children: "Delete" },
};

export const Small: Story = {
  args: { variant: "secondary", size: "sm", children: "Try again" },
};

export const Icon: Story = {
  args: {
    variant: "secondary",
    size: "icon",
    "aria-label": "Previous",
    children: <ChevronLeft className="h-4 w-4" />,
  },
};

export const Disabled: Story = {
  args: { variant: "primary", isDisabled: true, children: "Disabled" },
};

export const WithIcon: Story = {
  args: {
    variant: "ghost",
    children: (
      <>
        <Settings className="h-3.5 w-3.5" />
        Settings
      </>
    ),
  },
};

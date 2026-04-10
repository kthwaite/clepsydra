import type { Meta, StoryObj } from "@storybook/react";
import { Badge } from "#/components/ui/badge";

const meta: Meta<typeof Badge> = {
  title: "UI/Badge",
  component: Badge,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { children: "2026-04-10" },
};

export const Small: Story = {
  args: { children: "HIGH", size: "sm" },
};

export const ComingSoon: Story = {
  args: {
    children: "Coming Soon",
    size: "sm",
    className: "tracking-widest",
  },
};

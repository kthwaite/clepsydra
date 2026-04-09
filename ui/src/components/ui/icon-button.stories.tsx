import type { Meta, StoryObj } from "@storybook/react";
import { ChevronLeft, ChevronRight, Moon, X } from "lucide-react";
import { IconButton } from "#/components/ui/icon-button";

const meta: Meta<typeof IconButton> = {
  title: "UI/IconButton",
  component: IconButton,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Close: Story = {
  args: {
    "aria-label": "Close",
    children: <X />,
  },
};

export const PreviousDay: Story = {
  args: {
    "aria-label": "Previous day",
    children: <ChevronLeft />,
  },
};

export const NextDay: Story = {
  args: {
    "aria-label": "Next day",
    children: <ChevronRight />,
  },
};

export const ThemeToggle: Story = {
  args: {
    "aria-label": "Toggle theme",
    children: <Moon />,
  },
};

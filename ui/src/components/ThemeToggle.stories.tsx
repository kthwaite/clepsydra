import type { Meta, StoryObj } from "@storybook/react-vite";
import { ThemeProvider } from "#/components/ThemeProvider";
import { ThemeToggle } from "#/components/ThemeToggle";

const meta: Meta<typeof ThemeToggle> = {
  title: "Components/ThemeToggle",
  component: ThemeToggle,
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div className="p-8 bg-background text-foreground">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
  parameters: {
    layout: "centered",
  },
};

export default meta;
type Story = StoryObj<typeof ThemeToggle>;

export const Default: Story = {};

export const WithClassName: Story = {
  args: {
    className: "p-2 border border-border hover:bg-muted",
  },
};

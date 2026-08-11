import type { Meta, StoryObj } from "@storybook/react-vite";
import { TagCloud } from "./TagCloud";

const meta: Meta<typeof TagCloud> = {
  title: "Components/TagCloud",
  component: TagCloud,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    tags: [
      { tag: "rust", count: 12, computed_count: 0 },
      { tag: "react", count: 8, computed_count: 0 },
      { tag: "typescript", count: 6, computed_count: 0 },
      { tag: "database", count: 4, computed_count: 0 },
      { tag: "architecture", count: 3, computed_count: 0 },
    ],
  },
};

export const Empty: Story = {
  args: {
    tags: [],
  },
};

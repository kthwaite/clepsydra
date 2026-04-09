import type { Meta, StoryObj } from "@storybook/react";
import { SearchField } from "#/components/ui/search-field";

const meta: Meta<typeof SearchField> = {
  title: "UI/SearchField",
  component: SearchField,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: "Search pages..." },
};

export const WithValue: Story = {
  args: { placeholder: "Search pages...", defaultValue: "journal" },
};

import type { Meta, StoryObj } from "@storybook/react";
import { Radio, RadioGroup } from "#/components/ui/radio-group";

const meta: Meta<typeof RadioGroup> = {
  title: "UI/RadioGroup",
  component: RadioGroup,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <RadioGroup label="Tab Opening Mode" defaultValue="smart">
      <Radio value="smart">Smart</Radio>
      <Radio value="new">New Tab</Radio>
      <Radio value="replace">Replace</Radio>
    </RadioGroup>
  ),
};

export const WithDescription: Story = {
  render: () => (
    <RadioGroup
      label="Theme"
      defaultValue="system"
      description="Controls the overall color scheme"
    >
      <Radio value="light">Light</Radio>
      <Radio value="dark">Dark</Radio>
      <Radio value="system">System</Radio>
    </RadioGroup>
  ),
};

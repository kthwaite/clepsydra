import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { Checkbox } from "#/components/ui/checkbox";
import { CheckboxGroup } from "#/components/ui/checkbox-group";

const meta: Meta<typeof CheckboxGroup> = {
  title: "UI/CheckboxGroup",
  component: CheckboxGroup,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Vertical: Story = {
  render: () => (
    <CheckboxGroup label="Notifications" defaultValue={["security"]}>
      <Checkbox value="product">Product</Checkbox>
      <Checkbox value="security">Security</Checkbox>
    </CheckboxGroup>
  ),
};

export const Horizontal: Story = {
  render: () => (
    <CheckboxGroup label="Notifications" orientation="horizontal">
      <Checkbox value="product">Product</Checkbox>
      <Checkbox value="security">Security</Checkbox>
    </CheckboxGroup>
  ),
};

function ControlledCheckboxGroup() {
  const [value, setValue] = useState(["security"]);

  return (
    <div className="flex flex-col gap-2">
      <CheckboxGroup label="Notifications" value={value} onChange={setValue}>
        <Checkbox value="product">Product</Checkbox>
        <Checkbox value="security">Security</Checkbox>
      </CheckboxGroup>
      <p className="text-xs text-muted-foreground">
        Selected: {value.join(", ")}
      </p>
    </div>
  );
}

export const Controlled: Story = {
  render: () => <ControlledCheckboxGroup />,
};

export const RequiredInvalid: Story = {
  render: () => (
    <CheckboxGroup label="Kinds" isRequired isInvalid errorMessage="Required">
      <Checkbox value="note">Note</Checkbox>
      <Checkbox value="folder">Folder</Checkbox>
    </CheckboxGroup>
  ),
};

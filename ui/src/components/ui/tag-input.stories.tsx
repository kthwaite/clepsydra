import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";
import { TagInput } from "#/components/ui/tag-input";

const meta: Meta<typeof TagInput> = {
  title: "UI/TagInput",
  component: TagInput,
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  render: () => {
    const [values, setValues] = useState<string[]>([]);
    return (
      <TagInput
        label="Tags"
        values={values}
        onChange={setValues}
        placeholder="Add tag..."
      />
    );
  },
};

export const WithValues: Story = {
  render: () => {
    const [values, setValues] = useState(["react", "typescript", "tailwind"]);
    return (
      <TagInput
        label="Tags"
        values={values}
        onChange={setValues}
        placeholder="Add tag..."
      />
    );
  },
};

export const Aliases: Story = {
  render: () => {
    const [values, setValues] = useState(["TIL", "today-i-learned"]);
    return (
      <TagInput
        label="Aliases"
        values={values}
        onChange={setValues}
        placeholder="Add alias..."
      />
    );
  },
};

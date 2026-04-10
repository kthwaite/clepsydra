import type { Meta, StoryObj } from "@storybook/react";
import { EditorSuggestionPopover } from "#/components/ui/editor-suggestion-popover";

const meta: Meta<typeof EditorSuggestionPopover> = {
  title: "UI/EditorSuggestionPopover",
  component: EditorSuggestionPopover,
};

export default meta;
type Story = StoryObj<typeof meta>;

const MOCK_REF = {
  getBoundingClientRect: () => ({
    x: 100,
    y: 200,
    left: 100,
    top: 200,
    right: 100,
    bottom: 218,
    width: 0,
    height: 18,
    toJSON: () => ({}),
  }),
};

const ITEMS = [
  { id: "1", label: "Heading 1", description: "# Large heading" },
  { id: "2", label: "Heading 2", description: "## Medium heading" },
  { id: "3", label: "Bullet List", description: "- Unordered list" },
  { id: "4", label: "Numbered List", description: "1. Ordered list" },
  { id: "5", label: "Quote", description: "> Blockquote" },
];

export const Default: Story = {
  render: () => (
    <EditorSuggestionPopover
      items={ITEMS}
      query=""
      reference={MOCK_REF}
      onSelect={(item) => console.log("Selected:", item)}
      onClose={() => console.log("Closed")}
      renderItem={(item) => (
        <>
          <div className="font-medium">{item.label}</div>
          <div className="text-xs text-muted-foreground">
            {item.description}
          </div>
        </>
      )}
      getItemKey={(item) => item.id}
    />
  ),
};

export const Empty: Story = {
  render: () => (
    <EditorSuggestionPopover
      items={[]}
      query="xyz"
      reference={MOCK_REF}
      onSelect={() => {}}
      onClose={() => {}}
      renderItem={() => null}
      getItemKey={() => ""}
      emptyMessage="No results found"
    />
  ),
};

export const Loading: Story = {
  render: () => (
    <EditorSuggestionPopover
      items={[]}
      query="search"
      reference={MOCK_REF}
      onSelect={() => {}}
      onClose={() => {}}
      renderItem={() => null}
      getItemKey={() => ""}
      isLoading
      emptyMessage="No results"
    />
  ),
};

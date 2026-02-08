import type { Meta, StoryObj } from "@storybook/react";
import { ForceGraph } from "./ForceGraph";

const meta = {
  title: "Components/ForceGraph",
  component: ForceGraph,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof ForceGraph>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SmallGraph: Story = {
  args: {
    nodes: [
      { id: "1", path: "readme.md", title: "README" },
      { id: "2", path: "notes/daily.md", title: "Daily Notes" },
      { id: "3", path: "notes/ideas.md", title: "Ideas" },
      { id: "4", path: "projects/clepsydra.md", title: "Clepsydra" },
      { id: "5", path: "library/smith2024.md", title: "Smith 2024" },
    ],
    edges: [
      { source: "1", target: "2", kind: "wikilink" },
      { source: "2", target: "3", kind: "wikilink" },
      { source: "3", target: "4", kind: "wikilink" },
      { source: "4", target: "5", kind: "wikilink" },
      { source: "1", target: "4", kind: "wikilink" },
    ],
  },
  decorators: [
    (Story) => (
      <div style={{ width: "800px", height: "600px" }}>
        <Story />
      </div>
    ),
  ],
};

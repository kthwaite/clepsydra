import type { Meta, StoryObj } from "@storybook/react";
import type { GraphEdge, GraphNode } from "#/api/types";
import { ForceGraph } from "#/components/ForceGraph";

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
      { id: "1", path: "readme.md", title: "README", kind: "NOTE" },
      {
        id: "2",
        path: "notes/daily.md",
        title: "Daily Notes",
        kind: "JOURNAL",
      },
      { id: "3", path: "notes/ideas.md", title: "Ideas", kind: "TASK" },
      {
        id: "4",
        path: "projects/clepsydra.md",
        title: "Clepsydra",
        kind: "PROJECT",
      },
      {
        id: "5",
        path: "library/smith2024.md",
        title: "Smith 2024",
        kind: "BOOK",
      },
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

export const FocusedNeighborhood: Story = {
  ...SmallGraph,
  args: {
    ...SmallGraph.args,
    focusedIds: new Set(["1", "2", "4"]),
    selectedNodeId: "1",
  },
};

const denseNodes: GraphNode[] = Array.from({ length: 400 }, (_, index) => ({
  id: String(index),
  path: `${index % 2 ? "notes" : "projects"}/page-${index}.md`,
  title: `Page ${index}: a deliberately long descriptive title in a multi-hub graph`,
  kind: index < 4 ? "PROJECT" : index % 3 ? "NOTE" : "TASK",
}));
const denseEdges: GraphEdge[] = denseNodes.slice(4).map((node, index) => ({
  source: String(index % 4),
  target: node.id,
  kind: index % 5 ? "wikilink" : "property_ref",
}));

export const MultiHub: Story = {
  args: { nodes: denseNodes, edges: denseEdges },
  decorators: [
    (Story) => (
      <div style={{ width: "100vw", height: "100vh" }}>
        <Story />
      </div>
    ),
  ],
};

export const GroupedByKind: Story = {
  ...MultiHub,
  args: { ...MultiHub.args, groupBy: "kind" },
};

export const GroupedByFolder: Story = {
  ...MultiHub,
  args: { ...MultiHub.args, groupBy: "folder" },
};

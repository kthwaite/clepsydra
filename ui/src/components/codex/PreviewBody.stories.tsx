import type { Meta, StoryObj } from "@storybook/react-vite";
import type { PagePreviewProjection } from "#/api/bases";
import { PreviewBody } from "#/components/codex/PreviewBody";

const meta: Meta<typeof PreviewBody> = {
  title: "Codex/PreviewBody",
  component: PreviewBody,
};

export default meta;
type Story = StoryObj<typeof meta>;

const page = {
  meta: { title: "On Water Clocks", tags: ["history", "horology"] },
  body: "## history\n\nThe clepsydra measured time by regulated flow. Its earliest forms date to antiquity, long before mechanical escapements gave the hours their modern, even cadence.",
};

const successPreview = {
  fields: [
    {
      key: "status",
      label: "Reading status",
      present: true,
      value: "In progress",
      schema_conflict: false,
      label_conflict: false,
      sources: [
        {
          base: { slug: "research", name: "Research" },
          label: "Reading status",
        },
      ],
    },
    {
      key: "topics",
      label: "Topics",
      present: true,
      value: ["history", "engineering"],
      schema_conflict: false,
      label_conflict: false,
      sources: [
        { base: { slug: "research", name: "Research" }, label: "Topics" },
      ],
    },
    {
      key: "body",
      label: "Summary",
      present: true,
      value:
        "A water clock measures time through the regulated flow of liquid.",
      schema_conflict: false,
      label_conflict: false,
      sources: [
        { base: { slug: "research", name: "Research" }, label: "Summary" },
      ],
    },
  ],
  remaining_count: 2,
} satisfies PagePreviewProjection;

const conflictPreview = {
  fields: [
    {
      key: "status",
      label: "status",
      present: false,
      value: null,
      schema_conflict: true,
      label_conflict: true,
      sources: [
        {
          base: { slug: "reading", name: "Reading" },
          label: "Reading status",
        },
        {
          base: { slug: "research", name: "Research" },
          label: "Progress",
        },
      ],
    },
  ],
  remaining_count: 0,
} satisfies PagePreviewProjection;

export const Success: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody
        path="notes/water-clocks.md"
        page={page}
        backlinks={[1, 2, 3]}
        preview={successPreview}
        showTags
      />
    </div>
  ),
};

export const ConflictAndMissing: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody
        path="notes/water-clocks.md"
        page={page}
        backlinks={[1, 2, 3]}
        preview={conflictPreview}
        showTags={false}
      />
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody
        path="notes/water-clocks.md"
        page={page}
        backlinks={[1, 2, 3]}
        previewPending
      />
    </div>
  ),
};

export const Failure: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody
        path="notes/water-clocks.md"
        page={page}
        backlinks={[1, 2, 3]}
        previewError
      />
    </div>
  ),
};

export const Protected: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody
        path="notes/private.md"
        page={{ ...page, encrypted: true }}
        preview={successPreview}
        previewError
      />
    </div>
  ),
};

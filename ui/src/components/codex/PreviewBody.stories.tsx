import type { Meta, StoryObj } from "@storybook/react-vite";
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

export const WithTags: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody
        path="notes/water-clocks.md"
        page={page}
        backlinks={[1, 2, 3]}
        showTags
      />
    </div>
  ),
};

export const NoTags: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody
        path="notes/water-clocks.md"
        page={page}
        backlinks={[1, 2, 3]}
        showTags={false}
      />
    </div>
  ),
};

export const Loading: Story = {
  render: () => (
    <div className="w-[340px] border-[1.5px] border-ink bg-paper">
      <PreviewBody path="notes/water-clocks.md" showTags={false} />
    </div>
  ),
};

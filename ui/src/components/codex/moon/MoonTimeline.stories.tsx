import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { MoonTimeline } from "./MoonTimeline";
import { formatMoonInstant } from "./timeline";

const meta: Meta<typeof MoonTimeline> = {
  title: "Codex/Moon/MoonTimeline",
  component: MoonTimeline,
};

export default meta;
type Story = StoryObj<typeof meta>;

function Scrubber({ now }: { now: Date }) {
  const [value, setValue] = useState(now);
  return (
    <div style={{ maxWidth: 480 }}>
      <div className="mb-3 font-serif text-[22px] text-ink">
        {formatMoonInstant(value)}
      </div>
      <MoonTimeline value={value} now={now} onChange={setValue} />
    </div>
  );
}

export const Interactive: Story = {
  render: () => <Scrubber now={new Date()} />,
};

export const FixedNow: Story = {
  render: () => <Scrubber now={new Date(2026, 9, 3, 13)} />,
};

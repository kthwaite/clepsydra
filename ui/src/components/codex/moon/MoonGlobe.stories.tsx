import type { Meta, StoryObj } from "@storybook/react-vite";
import { LazyMoonGlobe } from "./LazyMoonGlobe";

const meta: Meta<typeof LazyMoonGlobe> = {
  title: "Codex/MoonGlobe",
  component: LazyMoonGlobe,
  args: {
    size: 420,
    fallback: <div className="text-mute">WebGL unavailable</div>,
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const LastQuarter: Story = {
  args: { date: new Date("2026-10-03T13:00:00Z") },
};

export const FullMoon: Story = {
  args: { date: new Date("2026-10-26T04:00:00Z") },
};

export const WaxingCrescent: Story = {
  args: { date: new Date("2026-10-13T18:00:00Z") },
};

export const FillsContainer: Story = {
  args: { date: new Date("2026-10-03T13:00:00Z"), size: undefined },
  render: (args) => (
    <div style={{ width: 280 }}>
      <LazyMoonGlobe {...args} />
    </div>
  ),
};

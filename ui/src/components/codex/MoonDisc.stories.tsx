import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoonDisc } from "./MoonDisc";
import { describeMoon } from "./sky";

const meta: Meta<typeof MoonDisc> = {
  title: "Codex/MoonDisc",
  component: MoonDisc,
};

export default meta;
type Story = StoryObj<typeof meta>;

const PHASES: { fraction: number; phase: number }[] = [
  { fraction: 0, phase: 0 },
  { fraction: 0.24, phase: 0.125 },
  { fraction: 0.5, phase: 0.25 },
  { fraction: 0.72, phase: 0.375 },
  { fraction: 1, phase: 0.5 },
  { fraction: 0.72, phase: 0.625 },
  { fraction: 0.5, phase: 0.75 },
  { fraction: 0.24, phase: 0.875 },
];

export const Gibbous: Story = {
  args: { info: describeMoon({ fraction: 0.72, phase: 0.375 }) },
};

export const AllPhases: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
      {PHASES.map((p) => {
        const info = describeMoon(p);
        return (
          <div key={info.phaseName} style={{ textAlign: "center" }}>
            <MoonDisc info={info} />
            <div
              className="cl-mono"
              style={{
                marginTop: 8,
                fontSize: 9,
                letterSpacing: "0.14em",
                textTransform: "uppercase",
                color: "var(--ink-mute)",
              }}
            >
              {info.phaseName} · {info.illumPct}%
            </div>
          </div>
        );
      })}
    </div>
  ),
};

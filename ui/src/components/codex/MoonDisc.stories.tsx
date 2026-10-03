import type { Meta, StoryObj } from "@storybook/react-vite";
import { MoonDisc } from "./MoonDisc";
import { moonAt } from "./moon/moon";
import { describeMoon } from "./sky";

const meta: Meta<typeof MoonDisc> = {
  title: "Codex/MoonDisc",
  component: MoonDisc,
};

export default meta;
type Story = StoryObj<typeof meta>;

function infoAt(date: Date) {
  const m = moonAt(date);
  return describeMoon({ fraction: m.illumFraction, phase: m.phase });
}

// One lunation, October 2026: new on the 10th, full on the 26th.
const DATES = [
  "2026-10-10T12:00:00Z",
  "2026-10-14T12:00:00Z",
  "2026-10-18T16:00:00Z",
  "2026-10-22T12:00:00Z",
  "2026-10-26T04:00:00Z",
  "2026-10-29T12:00:00Z",
  "2026-11-01T20:00:00Z",
  "2026-11-05T12:00:00Z",
].map((iso) => new Date(iso));

const GIBBOUS = new Date("2026-10-22T12:00:00Z");

export const Gibbous: Story = {
  args: { info: infoAt(GIBBOUS), date: GIBBOUS },
};

/** The disc is a button that opens the moon details. */
export const Pressable: Story = {
  args: { info: infoAt(GIBBOUS), date: GIBBOUS, onOpen: () => {} },
};

export const AllPhases: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 20 }}>
      {DATES.map((date) => {
        const info = infoAt(date);
        return (
          <div key={date.toISOString()} style={{ textAlign: "center" }}>
            <MoonDisc info={info} date={date} />
            <div className="mt-2 text-[12.5px] text-mute">
              {info.phaseName} · {info.illumPct}%
            </div>
          </div>
        );
      })}
    </div>
  ),
};

import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import type { CalendarMonth } from "./calendar";
import { MoonCalendar } from "./MoonCalendar";

const meta: Meta<typeof MoonCalendar> = {
  title: "Codex/Moon/MoonCalendar",
  component: MoonCalendar,
};

export default meta;
type Story = StoryObj<typeof meta>;

function Calendar({ today }: { today: Date }) {
  const [month, setMonth] = useState<CalendarMonth>({
    year: today.getFullYear(),
    monthIndex0: today.getMonth(),
  });
  const [selected, setSelected] = useState(today);
  return (
    <div style={{ maxWidth: 380 }}>
      <MoonCalendar
        month={month}
        onMonthChange={setMonth}
        selected={selected}
        today={today}
        onSelectDay={setSelected}
      />
    </div>
  );
}

export const October2026: Story = {
  render: () => <Calendar today={new Date(2026, 9, 3, 13)} />,
};

export const ThisMonth: Story = {
  render: () => <Calendar today={new Date()} />,
};

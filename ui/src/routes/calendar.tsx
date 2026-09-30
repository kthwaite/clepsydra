import { createFileRoute } from "@tanstack/react-router";

// Placeholder until the Calendar screen (C7) lands; C7 swaps the identity
// `validateSearch` for `validateCalendarSearch` (B3).
function CalendarPage() {
  return <h1>Calendar</h1>;
}

export const Route = createFileRoute("/calendar")({
  staticData: { codexView: "calendar" },
  validateSearch: (search: Record<string, unknown>) => search,
  component: CalendarPage,
});

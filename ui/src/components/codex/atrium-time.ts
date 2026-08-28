import { useMemo } from "react";
import { daystampLabel, formatDotDate } from "#/components/codex/atrium-data";
import { dayOfYear, isLeapYear } from "#/lib/time";

export function useAtriumCalendar(now: Date) {
  const year = now.getFullYear();
  const month = now.getMonth();
  const date = now.getDate();
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDay = now.getUTCDate();
  const dayKey = `${year}-${month}-${date}`;
  return useMemo(() => {
    const day = new Date(year, month, date);
    const utcDate = new Date(Date.UTC(utcYear, utcMonth, utcDay));
    const doy = dayOfYear(day);
    return {
      date: day,
      dayKey,
      dotDate: formatDotDate(day),
      doy,
      todayLabel: daystampLabel(day),
      utcDate,
      week: Math.ceil(doy / 7),
      yearDays: isLeapYear(year) ? 366 : 365,
    };
  }, [date, dayKey, month, utcDay, utcMonth, utcYear, year]);
}

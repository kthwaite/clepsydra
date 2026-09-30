import { useCallback } from "react";
import { toast } from "sonner";
import { useEnsureJournalForDate } from "#/api/journal";
import { useOpenTab } from "#/hooks/useOpenTab";
import type { DateKey } from "#/lib/calendar/dates";
import { todayJournalPath } from "#/lib/journal";
import { localDateKey } from "#/lib/time";

/**
 * Open the human journal for a local day as a folio tab, labelled with the
 * date key.
 * - A known path opens as is.
 * - Today opens its draft path; the file is created on first write, as
 *   `useOpenTodayJournal` does.
 * - Any other day is get-or-created on the server first. On failure it
 *   toasts and opens nothing. Never rejects.
 */
export function useOpenJournalForDate(): (
  dateKey: DateKey,
  existingPath?: string,
) => Promise<void> {
  const openTab = useOpenTab();
  const { mutateAsync } = useEnsureJournalForDate();
  return useCallback(
    async (dateKey: DateKey, existingPath?: string) => {
      if (existingPath) {
        openTab("page", existingPath, dateKey);
        return;
      }
      if (dateKey === localDateKey(new Date())) {
        openTab("page", todayJournalPath(), dateKey);
        return;
      }
      try {
        const { page } = await mutateAsync(dateKey);
        openTab("page", page.path, dateKey);
      } catch (error) {
        toast.error(`Could not open the journal for ${dateKey}`, {
          description: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [openTab, mutateAsync],
  );
}

import { useCallback } from "react";
import { useOpenTab } from "#/hooks/useOpenTab";
import { journalDateFromPath, todayJournalPath } from "#/lib/journal";

/** Open (or focus) today's journal as a workspace folio tab. The tab label
 *  starts as the date key; FOLIO's title-driven updateTabLabel takes over
 *  once the page loads. */
export function useOpenTodayJournal(): () => void {
  const openTab = useOpenTab();
  return useCallback(() => {
    const path = todayJournalPath();
    openTab("page", path, journalDateFromPath(path) ?? "today");
  }, [openTab]);
}

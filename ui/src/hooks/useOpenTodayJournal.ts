import { useCallback } from "react";
import { useJournalToday } from "#/api/journal";
import { useOpenTab } from "#/hooks/useOpenTab";
import { journalDateFromPath, todayJournalPath } from "#/lib/journal";

/** Open (or focus) today's journal as a workspace folio tab. The tab label
 *  starts as the date key; FOLIO's title-driven updateTabLabel takes over
 *  once the page loads. */
export function useOpenTodayJournal(): () => void {
  const openTab = useOpenTab();
  const { data: journalToday, refetch } = useJournalToday();
  return useCallback(async () => {
    let page = journalToday;
    if (page === undefined) {
      const result = await refetch();
      if (result.isError) return;
      page = result.data ?? null;
    }
    const draftPath = todayJournalPath();
    const path = page?.path ?? draftPath;
    const label =
      page?.meta.title ?? journalDateFromPath(draftPath) ?? "today";
    openTab("page", path, label);
  }, [journalToday, openTab, refetch]);
}

import { useCallback } from "react";
import { useAiJournalToday } from "#/api/aiJournal";
import { useOpenTab } from "#/hooks/useOpenTab";
import { aiJournalDateFromPath, todayAiJournalPath } from "#/lib/journal";

/** Open (or focus) today's AI journal as a workspace folio tab. */
export function useOpenTodayAiJournal(): () => void {
  const openTab = useOpenTab();
  const { data: aiToday, refetch } = useAiJournalToday();
  return useCallback(async () => {
    let page = aiToday;
    if (page === undefined) {
      const result = await refetch();
      if (result.isError) return;
      page = result.data ?? null;
    }
    const draftPath = todayAiJournalPath();
    const path = page?.path ?? draftPath;
    const label =
      page?.meta.title ?? aiJournalDateFromPath(draftPath) ?? "today";
    openTab("page", path, label);
  }, [aiToday, openTab, refetch]);
}

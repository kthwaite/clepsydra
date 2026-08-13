import {
  type OpenTabWithFolioHistory,
  useOpenTabWithFolioHistory,
} from "#/hooks/useFolioHistoryNavigation";

export function useOpenTab(): OpenTabWithFolioHistory {
  return useOpenTabWithFolioHistory();
}

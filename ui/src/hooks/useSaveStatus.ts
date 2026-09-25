import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

/** Footer save state: any vault write in flight, and when the last one
 *  succeeded this session. A failed write leaves `savedAt` untouched. */
export function useSaveStatus(): { saving: boolean; savedAt: number | null } {
  const client = useQueryClient();
  const saving = useIsMutating() > 0;
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(
    () =>
      client.getMutationCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success") {
          setSavedAt(Date.now());
        }
      }),
    [client],
  );
  return { saving, savedAt };
}

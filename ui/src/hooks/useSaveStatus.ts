import { useIsMutating, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NO_SAVE, savesNothing } from "#/api/mutationMeta";

export { NO_SAVE };

/** Footer save state: any vault write in flight, and when the last one
 *  succeeded this session. A failed write leaves `savedAt` untouched, and
 *  NO_SAVE mutations (previews, searches, fetches) never count. */
export function useSaveStatus(): { saving: boolean; savedAt: number | null } {
  const client = useQueryClient();
  const saving =
    useIsMutating({ predicate: (m) => !savesNothing(m.options.meta) }) > 0;
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(
    () =>
      client.getMutationCache().subscribe((event) => {
        if (
          event.type === "updated" &&
          event.action.type === "success" &&
          !savesNothing(event.mutation.options.meta)
        ) {
          setSavedAt(Date.now());
        }
      }),
    [client],
  );
  return { saving, savedAt };
}

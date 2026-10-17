import { useCallback } from "react";
import { toast } from "sonner";
import { type QueryRow, usePropertyCommit } from "#/api/bases";
import { fetchClient } from "#/api/client";
import { formatApiError, isApiConflict } from "#/api/error";
import { useArchivePage, useUpdatePage } from "#/api/pages";
import type {
  BaseBulkAction,
  BaseBulkResult,
  BaseTableBulk,
} from "./base-table-model";
import { propertyKey } from "./property-schema";

/** Each page keeps the existing guarded write and rubbish-bin semantics. */
export function useBaseBulkActions(
  refresh: () => Promise<unknown>,
): BaseTableBulk {
  const commit = usePropertyCommit();
  const { mutateAsync: archive } = useArchivePage();
  const { mutateAsync: update } = useUpdatePage();
  const run = useCallback(
    async (
      rows: QueryRow[],
      action: BaseBulkAction,
    ): Promise<BaseBulkResult> => {
      const result: BaseBulkResult = { succeeded: [], failures: [] };
      for (const row of rows) {
        try {
          if (action.kind === "archive") {
            await archive({ params: { path: { path: row.path } } });
          } else {
            const page = await fetchClient.GET("/api/vault/pages/{path}", {
              params: { path: { path: row.path } },
            });
            if (page.error) throw page.error;
            if (!page.data) throw new Error("Page revision unavailable.");
            if (page.data.encrypted)
              throw new Error("Protected page: unlock it before bulk editing.");
            if (action.kind === "tag") {
              const tags = [
                ...new Set([...(page.data.meta.tags ?? []), action.tag]),
              ];
              await update({
                params: { path: { path: row.path } },
                body: { expected_revision: page.data.revision, tags },
              });
            } else {
              await commit(
                row,
                propertyKey(action.key),
                action.value,
                action.type,
                page.data.revision,
                { quiet: true },
              );
            }
          }
          result.succeeded.push(row.id);
        } catch (error) {
          const message = `${isApiConflict(error) ? "Conflict (409): " : ""}${formatApiError(error, "The page could not be updated.")}`;
          result.failures.push({
            id: row.id,
            label: row.title ?? row.path,
            message,
          });
        }
      }
      let refreshError = "";
      try {
        await refresh();
      } catch (error) {
        refreshError = ` Refresh failed: ${formatApiError(error, "Reload the view.")}`;
      }
      const summary = `${result.succeeded.length} of ${rows.length} pages ${action.kind === "archive" ? "archived" : "updated"}.${refreshError}`;
      if (result.failures.length || refreshError)
        toast.error(summary, {
          description: result.failures
            .map((failure) => `${failure.label}: ${failure.message}`)
            .join("; "),
        });
      else toast.success(summary);
      return result;
    },
    [archive, commit, refresh, update],
  );
  return { run };
}

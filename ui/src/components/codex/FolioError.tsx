import { shortFolio } from "#/components/codex/folio-utils";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { queryClient } from "#/lib/queryClient";

/** Reset every errored query so a retry can refetch instead of instantly
 *  re-surfacing the same persisted error. */
export function resetErroredQueries(): void {
  void queryClient.resetQueries({
    predicate: (query) => query.state.status === "error",
  });
}

/** Coerce an unknown thrown/query error into an Error for display. */
export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return new Error(value.error);
  }
  return new Error(String(value));
}

/**
 * Recovery panel shown when loading or rendering a folio failed. Unlike
 * FolioNotFound this makes no claim about the file — the page is usually
 * intact and the failure was transient (a failed query, a bad selection
 * during a remount). RETRY resets errored queries (and, from the boundary,
 * the latched error); CLOSE TAB removes the offending tab.
 */
export function FolioError({
  path,
  error,
  onRetry,
  onClose,
}: {
  path: string;
  error: Error;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="w-full max-w-[440px] rounded-2xl bg-raise px-7 py-6">
        <span className="flex items-center gap-2.5">
          <Tick variant="faint" />
          <span className="min-w-0 truncate font-serif text-[18px] italic text-mute">
            {path ? shortFolio(path) : "Render error"}
          </span>
        </span>
        <p className="mt-3 mb-2 font-serif text-[28px] leading-tight text-ink">
          Folio hit an error.
        </p>
        <p className="mb-3 text-[14px] text-ink-2">
          The file is likely intact — retry, or close this tab.
        </p>
        <p className="mb-5 break-all text-[13px] text-hot">
          {error.message || String(error)}
        </p>
        <div className="flex gap-2">
          <Button variant="primary" onPress={onRetry}>
            Retry
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Close tab
          </Button>
        </div>
      </div>
    </div>
  );
}

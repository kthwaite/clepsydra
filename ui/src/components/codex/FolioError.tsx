import { shortFolio } from "#/components/codex/folio-utils";
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
      <div className="w-full max-w-[440px] border border-rule">
        <div className="flex items-baseline justify-between border-b border-rule px-3 py-1.5">
          <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
            FILE / {path ? shortFolio(path) : "—"}
          </span>
          <span className="cl-mono text-[9px] uppercase tracking-[0.16em] text-hot">
            ⁂ RENDER ERROR
          </span>
        </div>
        <div className="px-4 py-4">
          <p className="cl-mono mb-2 text-[12px] text-ink">
            Folio hit an error.
          </p>
          <p className="cl-marg mb-3 text-[12px]">
            The file is likely intact — retry, or close this tab.
          </p>
          <p className="cl-mono mb-4 break-all text-[11px] text-hot">
            {error.message || String(error)}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onRetry}
              className="cl-mono cursor-pointer border border-rule px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-ink hover:border-ink"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={onClose}
              className="cl-mono cursor-pointer border border-rule px-3 py-1 text-[10px] uppercase tracking-[0.14em] text-ink-mute hover:border-ink hover:text-ink"
            >
              Close tab
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

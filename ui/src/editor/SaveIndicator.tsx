import type { RevisionConflict, SaveStatus } from "./usePageEditor";

interface SaveIndicatorProps {
  status: SaveStatus;
  error?: string | null;
  revisionConflict?: RevisionConflict | null;
  onReloadAfterConflict?: () => Promise<void>;
}

export function SaveIndicator({
  status,
  error,
  revisionConflict,
  onReloadAfterConflict,
}: SaveIndicatorProps) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {status === "saved" && (
        <span className="text-muted-foreground">Saved</span>
      )}
      {status === "saving" && (
        <span className="text-muted-foreground animate-pulse">Saving...</span>
      )}
      {status === "unsaved" && (
        <span className="text-foreground">Unsaved changes</span>
      )}
      {status === "error" &&
        (revisionConflict && onReloadAfterConflict ? (
          <>
            <span className="text-destructive" title={error ?? undefined}>
              Page changed on disk
            </span>
            <button
              type="button"
              className="text-destructive underline underline-offset-2 hover:no-underline focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
              onClick={() => {
                if (
                  window.confirm(
                    "Reload this page from disk? Your unsaved changes will be discarded.",
                  )
                ) {
                  void onReloadAfterConflict();
                }
              }}
            >
              Reload from disk
            </button>
          </>
        ) : (
          <span className="text-destructive" title={error ?? undefined}>
            Save failed
          </span>
        ))}
    </div>
  );
}

import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import type { RevisionConflict, SaveStatus } from "./usePageEditor";

interface SaveIndicatorProps {
  status: SaveStatus;
  error?: string | null;
  revisionConflict?: RevisionConflict | null;
  onReloadAfterConflict?: () => Promise<void>;
}

function Dot({ className }: { className: string }) {
  return (
    <span
      data-dot
      aria-hidden
      className={cn("h-1.5 w-1.5 shrink-0 rounded-full", className)}
    />
  );
}

/** Save state as a dot and a word (Folio header, mobile page bar). */
export function SaveIndicator({
  status,
  error,
  revisionConflict,
  onReloadAfterConflict,
}: SaveIndicatorProps) {
  return (
    <div className="flex items-center gap-1.5 text-[12.5px] text-mute">
      {status === "saved" && (
        <>
          <Dot className="bg-accent" />
          <span>Saved</span>
        </>
      )}
      {status === "saving" && (
        <>
          <Dot className="animate-pulse bg-accent" />
          <span>Saving…</span>
        </>
      )}
      {status === "unsaved" && (
        <>
          <Dot className="bg-faint" />
          <span>Unsaved changes</span>
        </>
      )}
      {status === "error" &&
        (revisionConflict && onReloadAfterConflict ? (
          <>
            <Dot className="bg-hot" />
            <span className="text-hot" title={error ?? undefined}>
              Page changed on disk
            </span>
            <button
              type="button"
              className={cn(
                "rounded-sm text-hot underline underline-offset-2 hover:no-underline",
                FOCUS_RING_NATIVE,
              )}
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
          <>
            <Dot className="bg-hot" />
            <span className="text-hot" title={error ?? undefined}>
              Save failed
            </span>
          </>
        ))}
    </div>
  );
}

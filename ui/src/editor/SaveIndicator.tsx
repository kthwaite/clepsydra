import type { SaveStatus } from "./usePageEditor";

interface SaveIndicatorProps {
  status: SaveStatus;
  error?: string | null;
}

export function SaveIndicator({ status, error }: SaveIndicatorProps) {
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
      {status === "error" && (
        <span className="text-destructive" title={error ?? undefined}>
          Save failed
        </span>
      )}
    </div>
  );
}

import { useSyncState } from "#/components/SyncIndicator";
import { useSaveStatus } from "#/hooks/useSaveStatus";
import { cn } from "#/lib/cn";

/** Mobile status (spec §9 Q3): one dot for sync and save state. Problems
 *  outrank saving; saving outranks the calm states. */
export function StatusDot() {
  const sync = useSyncState();
  const { saving } = useSaveStatus();
  const problem = sync.status === "offline" || sync.status === "disconnected";
  const showSaving = !problem && saving;
  const state = problem
    ? sync.status
    : showSaving
      ? "saving"
      : sync.status === "connecting"
        ? "connecting"
        : "synced";
  const word = showSaving ? "Saving…" : sync.word;
  const dot = showSaving ? "bg-accent animate-pulse" : sync.dot;

  return (
    <span
      role="status"
      data-state={state}
      title={word}
      className="flex h-11 w-5 items-center justify-center"
    >
      <span aria-hidden className={cn("h-[7px] w-[7px] rounded-full", dot)} />
      <span className="sr-only">{word}</span>
    </span>
  );
}

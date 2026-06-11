import { useBoard } from "#/api/board";

/** Placeholder for the Tasking board screen — Task 8 builds this out fully. */
export function TaskingScreen() {
  const { data, isLoading, isError } = useBoard();

  if (isLoading) {
    return (
      <div className="cl-mono flex h-full items-center justify-center text-[11px] uppercase tracking-[0.18em] text-ink-mute">
        LOADING
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="cl-mono flex h-full items-center justify-center text-[11px] uppercase tracking-[0.18em] text-[var(--hot)]">
        ERROR — board unavailable
      </div>
    );
  }

  return (
    <div className="cl-mono flex h-full flex-col items-center justify-center gap-2 text-ink-mute">
      <span className="text-[13px] uppercase tracking-[0.22em] text-ink">
        TASKING
      </span>
      <span className="text-[10px] tracking-[0.14em] opacity-60">
        {data.tasks.length} tasks · {data.cycles.length} cycles
      </span>
    </div>
  );
}

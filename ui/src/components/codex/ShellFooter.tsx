import { Check } from "lucide-react";
import { useEffect, useState } from "react";
import { useStats } from "#/api/index";
import { FooterControlsHost } from "#/components/codex/FooterControls";
import { useReadingProgress } from "#/components/codex/ReadingProgressContext";
import type { CodexView } from "#/components/codex/useCodexView";
import { SyncIndicator } from "#/components/SyncIndicator";
import { useSaveStatus } from "#/hooks/useSaveStatus";
import { formatRelativeTime } from "#/lib/time";
import { useFooterParts } from "#/store/footerContext";

/** Re-render every 30s so relative times stay honest. Scoped to the leaves
 *  so the shell itself does not re-render on the tick. */
function useTick(ms = 30_000) {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function SaveState() {
  useTick();
  const { saving, savedAt } = useSaveStatus();
  if (saving)
    return (
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
        />
        Saving…
      </span>
    );
  if (savedAt === null) return null;
  return (
    <span className="flex items-center gap-1">
      <Check aria-hidden className="h-3 w-3" />
      {`Saved ${formatRelativeTime(new Date(savedAt).toISOString())}`}
    </span>
  );
}

function Context({ view }: { view: CodexView }) {
  useTick();
  const parts = useFooterParts();
  const { progress } = useReadingProgress();
  const { data: stats } = useStats();
  const all = [
    ...(view === "folio" ? parts : []),
    ...(view === "folio"
      ? [`${Math.round(Math.max(0, Math.min(1, progress)) * 100)}% read`]
      : []),
    ...(stats?.last_indexed_at
      ? [`Indexed ${formatRelativeTime(stats.last_indexed_at)}`]
      : []),
  ];
  return <span className="min-w-0 truncate">{all.join(" · ")}</span>;
}

/** The simplified shell footer (spec decision 12): sync and save state on
 *  the left, the current screen's context on the right. */
export function ShellFooter({ view }: { view: CodexView }) {
  return (
    <footer className="order-3 flex h-[34px] flex-shrink-0 items-center gap-5 bg-sink px-10 text-[12.5px] text-mute">
      <SyncIndicator />
      <SaveState />
      <span className="flex-1" />
      <Context view={view} />
      <FooterControlsHost />
    </footer>
  );
}

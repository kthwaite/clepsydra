import type { ReactNode } from "react";
import { useFeeds } from "#/api/feeds";
import { useSyncConflicts } from "#/api/index";
import type { CodexView } from "#/components/codex/useCodexView";
import { isCoreView } from "#/components/codex/viewRegistry";
import { cn } from "#/lib/cn";

function Badge({ children, warn }: { children: ReactNode; warn?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-[11.5px] tabular-nums",
        warn ? "bg-warn/12 text-warn" : "bg-accent-tint text-accent",
      )}
    >
      {children}
    </span>
  );
}

/** Mounted only while its row renders, so the feeds query never runs when
 *  Feeds is disabled or Contents is closed. */
function FeedsBadge() {
  const unread = useFeeds().data?.counts.unread ?? 0;
  return unread > 0 ? <Badge>{unread}</Badge> : null;
}

function ConflictsBadge() {
  const total = useSyncConflicts().data?.total ?? 0;
  return total > 0 ? <Badge warn>{total}</Badge> : null;
}

/** The Contents row badge: "core" for header screens (desktop only), unread
 *  feeds, or waiting conflicts. */
export function ContentsBadge({
  view,
  showCore = true,
}: {
  view: CodexView;
  showCore?: boolean;
}) {
  if (showCore && isCoreView(view)) return <Badge>core</Badge>;
  if (view === "feeds") return <FeedsBadge />;
  if (view === "conflicts") return <ConflictsBadge />;
  return null;
}

import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useFeeds } from "#/api/feeds";
import { ContentsBadge } from "#/components/codex/ContentsBadge";
import { Tick } from "#/components/codex/Tick";
import type { CodexView } from "#/components/codex/useCodexView";
import {
  contentsGroups,
  enabledNavItems,
  goToView,
  MOBILE_GO_TO,
  VIEW_REGISTRY,
} from "#/components/codex/viewRegistry";
import { useFeatureFlags } from "#/components/FeatureFlagsProvider";
import {
  useActivateTabWithFolioHistory,
  useLeaveFolioWorkspace,
} from "#/hooks/useFolioHistoryNavigation";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

const CHIP = cn(
  "flex h-9 items-center rounded-full bg-sink px-3.5 text-[14px] text-ink",
  FOCUS_RING_NATIVE,
);

function Eyebrow({ children }: { children: string }) {
  return (
    <h2
      className="flex items-center gap-2.5 font-serif text-[19px] italic text-mute"
    >
      <Tick />
      {children}
    </h2>
  );
}

/** Mounted only while Feeds is enabled, so the feeds query never runs
 *  otherwise. */
function FeedsLabel() {
  const unread = useFeeds().data?.counts.unread ?? 0;
  return <>{unread > 0 ? `Feeds · ${unread}` : "Feeds"}</>;
}

/** Mobile Search's "Go to" block (spec §9 Q3): chips for the screens that
 *  are not on the bottom bar, and Contents for every screen. */
export function MobileGoTo({ onGo }: { onGo: () => void }) {
  const features = useFeatureFlags();
  const navigate = useNavigate();
  const openTab = useOpenTab();
  const activateTab = useActivateTabWithFolioHistory();
  const leaveWorkspace = useLeaveFolioWorkspace();
  const [contentsOpen, setContentsOpen] = useState(false);
  const contentsId = useId();

  const go = (view: CodexView) => {
    goToView(view, { navigate, openTab, activateTab, leaveWorkspace });
    onGo();
  };

  return (
    <section className="flex flex-col gap-3.5 px-3 pt-6 pb-4">
      <Eyebrow>Go to</Eyebrow>
      <div className="ml-[17px] flex flex-wrap gap-2">
        {enabledNavItems(MOBILE_GO_TO, features).map((view) => (
          <button
            key={view}
            type="button"
            onClick={() => go(view)}
            className={CHIP}
          >
            {view === "feeds" ? <FeedsLabel /> : VIEW_REGISTRY[view].label}
          </button>
        ))}
        <button
          type="button"
          aria-expanded={contentsOpen}
          aria-controls={contentsOpen ? contentsId : undefined}
          onClick={() => setContentsOpen((open) => !open)}
          className={CHIP}
        >
          Contents…
        </button>
      </div>
      {contentsOpen && (
        <div id={contentsId} className="flex flex-col gap-5 pt-2">
          {contentsGroups(features).map(({ group, views }) => (
            <div key={group} className="flex flex-col gap-1">
              <Eyebrow>{group}</Eyebrow>
              {views.map((view) => (
                <button
                  key={view}
                  type="button"
                  onClick={() => go(view)}
                  className={cn(
                    "ml-[5px] flex min-h-11 flex-col rounded-xl px-3 py-2 text-left",
                    FOCUS_RING_NATIVE,
                  )}
                >
                  <span className="flex items-center gap-2 text-[15.5px] text-ink">
                    {VIEW_REGISTRY[view].label}
                    <ContentsBadge view={view} showCore={false} />
                  </span>
                  <span className="text-[13px] text-mute">
                    {VIEW_REGISTRY[view].description}
                  </span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

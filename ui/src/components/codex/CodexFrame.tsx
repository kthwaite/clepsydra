import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { DesktopCodexFrame } from "#/components/codex/DesktopCodexFrame";
import { MobileCodexFrame } from "#/components/codex/MobileCodexFrame";
import { useCodexView } from "#/components/codex/useCodexView";
import type { CodexView } from "#/components/codex/useCodexView";
import { VIEW_REGISTRY } from "#/components/codex/viewRegistry";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { cn } from "#/lib/cn";

export type CodexFrameProps = {
  children: ReactNode;
  /** Test-only: pin the view so router/store state isn't the variable under test. */
  forceView?: CodexView;
};

export type CodexFrameChromeProps = Omit<CodexFrameProps, "children"> & {
  bottomSlot: Element | null;
};

export function CodexFrame({ children, forceView }: CodexFrameProps) {
  const mobile = useMobileLayout();
  const { pathname } = useLocation();
  const [bottomSlot, setBottomSlot] = useState<HTMLDivElement | null>(null);
  const resolvedView = useCodexView();
  const view = forceView ?? resolvedView;
  const fullPage = VIEW_REGISTRY[view].fullPage === true;

  return (
    <div
      className={cn(
        "cl-root cl-paper flex w-screen flex-col overflow-hidden",
        mobile ? "h-dvh" : "h-screen",
      )}
    >
      {!fullPage &&
        (mobile ? (
          <MobileCodexFrame bottomSlot={bottomSlot} forceView={forceView} />
        ) : (
          <DesktopCodexFrame bottomSlot={bottomSlot} forceView={forceView} />
        ))}
      <main
        className={
          fullPage
            ? "h-full min-h-0"
            : cn(
                "order-2 flex-1 overflow-auto",
                mobile ? "min-h-0" : "cl-noscroll relative",
              )
        }
      >
        <div
          key={pathname}
          className={cn(
            "view-anim",
            fullPage || !mobile ? "h-full" : "min-h-full",
          )}
        >
          {children}
        </div>
      </main>
      <div className="contents" ref={setBottomSlot} />
    </div>
  );
}

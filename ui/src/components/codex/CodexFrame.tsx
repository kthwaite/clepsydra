import { useLocation } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import { DesktopCodexFrame } from "#/components/codex/DesktopCodexFrame";
import { MobileCodexFrame } from "#/components/codex/MobileCodexFrame";
import type { CodexView } from "#/components/codex/useCodexView";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { cn } from "#/lib/cn";

export type CodexFrameProps = {
  children: ReactNode;
  /** override automatic view detection; usually unnecessary */
  forceView?: CodexView;
};

export type CodexFrameChromeProps = Omit<CodexFrameProps, "children"> & {
  pathname: string;
  bottomSlot: Element | null;
};

export function CodexFrame({ children, forceView }: CodexFrameProps) {
  const mobile = useMobileLayout();
  const { pathname } = useLocation();
  const [bottomSlot, setBottomSlot] = useState<HTMLDivElement | null>(null);

  return (
    <div
      className={cn(
        "cl-root cl-paper flex w-screen flex-col overflow-hidden",
        mobile ? "h-dvh" : "h-screen",
      )}
    >
      {mobile ? (
        <MobileCodexFrame
          bottomSlot={bottomSlot}
          forceView={forceView}
          pathname={pathname}
        />
      ) : (
        <DesktopCodexFrame
          bottomSlot={bottomSlot}
          forceView={forceView}
          pathname={pathname}
        />
      )}
      <main
        className={cn(
          "order-2 flex-1 overflow-auto",
          mobile ? "min-h-0" : "cl-noscroll relative",
        )}
      >
        <div
          key={pathname}
          className={cn("view-anim", mobile ? "min-h-full" : "h-full")}
        >
          {children}
        </div>
      </main>
      <div className="contents" ref={setBottomSlot} />
    </div>
  );
}

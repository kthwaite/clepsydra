import type { ReactNode } from "react";
import { DesktopCodexFrame } from "#/components/codex/DesktopCodexFrame";
import { MobileCodexFrame } from "#/components/codex/MobileCodexFrame";
import type { CodexView } from "#/components/codex/useCodexView";
import { useMobileLayout } from "#/hooks/useMobileLayout";

export type CodexFrameProps = {
  children: ReactNode;
  /** override automatic view detection; usually unnecessary */
  forceView?: CodexView;
};

export function CodexFrame(props: CodexFrameProps) {
  return useMobileLayout() ? (
    <MobileCodexFrame {...props} />
  ) : (
    <DesktopCodexFrame {...props} />
  );
}

import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useFooterControlsStore } from "#/store/footerControls";

/** The footer's portal target; ShellFooter renders it on the right. */
export function FooterControlsHost() {
  const setHost = useFooterControlsStore((s) => s.setHost);
  return (
    <span
      data-slot="footer-controls"
      ref={setHost}
      className="flex items-center gap-4 empty:hidden"
    />
  );
}

/** Renders `children` in the shell footer while mounted. */
export function FooterControls({ children }: { children: ReactNode }) {
  const host = useFooterControlsStore((s) => s.host);
  return host ? createPortal(children, host) : null;
}

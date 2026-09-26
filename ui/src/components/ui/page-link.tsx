import type { ReactNode } from "react";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";

export interface PageLinkProps {
  path: string;
  label?: string;
  children: ReactNode;
  className?: string;
}

export function PageLink({ path, label, children, className }: PageLinkProps) {
  const openTab = useOpenTab();

  return (
    <button
      type="button"
      onClick={() => openTab("page", path, label)}
      className={cn(
        "text-left text-ink underline decoration-rule underline-offset-2 hover:decoration-ink",
        className,
      )}
    >
      {children}
    </button>
  );
}

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
        "text-left text-foreground underline decoration-border underline-offset-2 hover:decoration-foreground",
        className,
      )}
    >
      {children}
    </button>
  );
}

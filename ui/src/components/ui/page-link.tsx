import type { ReactNode } from "react";
import { cn } from "#/components/ui/utils";
import { useOpenTab } from "#/hooks/useOpenTab";

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

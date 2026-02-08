import type { ReactNode } from "react";
import { Sidebar } from "#/components/Sidebar";
import { SyncIndicator } from "#/components/SyncIndicator";
import { ThemeToggle } from "#/components/ThemeToggle";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-end gap-3 border-b border-border px-4 py-2">
          <SyncIndicator />
          <ThemeToggle className="inline-flex h-8 w-8 items-center justify-center border border-border bg-background text-foreground" />
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

import { Search } from "lucide-react";
import type { ReactNode } from "react";
import { SearchPalette } from "#/components/SearchPalette";
import { Sidebar } from "#/components/Sidebar";
import { SyncIndicator } from "#/components/SyncIndicator";
import { ThemeToggle } from "#/components/ThemeToggle";

export function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-background text-foreground">
      <SearchPalette />
      <Sidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex items-center justify-end gap-3 border-b border-border px-4 py-2">
          <button
            type="button"
            onClick={() =>
              window.dispatchEvent(
                new KeyboardEvent("keydown", { key: "k", metaKey: true }),
              )
            }
            className="flex items-center gap-2 border border-border px-3 py-1 text-xs text-muted-foreground hover:bg-accent"
          >
            <Search className="h-3 w-3" />
            Search
            <kbd className="border border-border px-1 py-0.5 text-[10px]">
              ⌘K
            </kbd>
          </button>
          <SyncIndicator />
          <ThemeToggle className="inline-flex h-8 w-8 items-center justify-center border border-border bg-background text-foreground" />
        </header>
        <main className="flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

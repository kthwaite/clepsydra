import { Link } from "@tanstack/react-router";
import { PageList } from "#/components/PageList";

export function Sidebar() {
  return (
    <aside className="flex w-64 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <Link
          to="/"
          className="text-sm font-bold uppercase tracking-widest text-foreground"
        >
          clepsydra
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <PageList />
      </nav>
      <div className="border-t border-border px-2 py-2">
        {/* Tags section will go here */}
      </div>
    </aside>
  );
}

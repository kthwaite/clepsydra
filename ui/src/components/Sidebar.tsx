import { Link } from "@tanstack/react-router";
import { useTags } from "#/api/index";
import { FileTree } from "#/components/FileTree";

export function Sidebar() {
  const { data: tags } = useTags();

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
      <div className="flex border-b border-border">
        <Link
          to="/"
          className="flex-1 px-3 py-1.5 text-center text-xs uppercase tracking-wider hover:bg-accent"
          activeProps={{ className: "bg-accent font-bold" }}
          activeOptions={{ exact: true }}
        >
          Pages
        </Link>
        <Link
          to="/graph"
          className="flex-1 border-l border-border px-3 py-1.5 text-center text-xs uppercase tracking-wider hover:bg-accent"
          activeProps={{ className: "bg-accent font-bold" }}
        >
          Graph
        </Link>
      </div>
      <nav className="flex-1 overflow-y-auto px-2 py-2">
        <FileTree />
      </nav>
      <div className="border-t border-border px-2 py-2">
        {tags && tags.length > 0 && (
          <>
            <p className="mb-1 px-2 text-xs font-bold uppercase tracking-widest text-muted-foreground">
              Tags
            </p>
            <ul className="space-y-px">
              {tags.slice(0, 15).map((t) => (
                <li
                  key={t.tag}
                  className="flex items-center justify-between px-2 py-0.5 text-xs"
                >
                  <span>{t.tag}</span>
                  <span className="text-muted-foreground">{t.count}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </aside>
  );
}

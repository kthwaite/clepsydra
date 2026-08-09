import { createRootRoute, HeadContent, Link, Outlet } from "@tanstack/react-router";
import { type Feed, useFeeds } from "#/lib/api";

export const Route = createRootRoute({
  notFoundComponent: () => <div className="p-8 text-sm">404 — not found</div>,
  head: () => ({
    meta: [
      {
        title: "clepsydra",
      },
    ],
  }),
  component: Shell,
});

/** The persistent frame: sidebar navigation shared by every surface. */
function Shell() {
  return (
    <main className="flex h-screen font-sans text-sm text-zinc-800 bg-white dark:bg-zinc-950 dark:text-zinc-200">
      <HeadContent />
      <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900">
        <div className="px-4 pt-5 pb-3">
          <Link to="/" className="text-base font-semibold tracking-tight">
            clepsydra
          </Link>
        </div>
        <nav className="px-2">
          <NavLink to="/" label="Home" />
          <NavLink to="/feeds" label="Feeds" />
        </nav>
        <GroupNav />
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </main>
  );
}

function NavLink({ to, label }: { to: string; label: string }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact: to === "/", includeSearch: false }}
      className="block rounded px-2 py-1 hover:bg-zinc-200/60 dark:hover:bg-zinc-800"
      activeProps={{ className: "font-medium bg-zinc-200/60 dark:bg-zinc-800" }}
    >
      {label}
    </Link>
  );
}

/** Feed groups (feeds.md sections) with unread counts, Reeder-style. */
function GroupNav() {
  const { data } = useFeeds();
  if (!data) return <div className="flex-1" />;

  const groups = new Map<string, Feed[]>();
  for (const f of data.feeds) {
    const key = f.group ?? "Ungrouped";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)?.push(f);
  }

  return (
    <div className="mt-4 flex-1 overflow-y-auto px-2 pb-4">
      {[...groups.entries()].map(([group, feeds]) => {
        const unread = feeds.reduce((n, f) => n + f.unread_count, 0);
        return (
          <div key={group} className="mb-3">
            <Link
              to="/"
              search={{ group }}
              className="flex items-baseline justify-between rounded px-2 py-0.5 text-xs font-semibold uppercase tracking-wide text-zinc-500 hover:bg-zinc-200/60 dark:text-zinc-400 dark:hover:bg-zinc-800"
            >
              <span className="truncate">{group}</span>
              {unread > 0 && <span className="ml-2 tabular-nums">{unread}</span>}
            </Link>
            {feeds.map((f) => (
              <Link
                key={f.id}
                to="/"
                search={{ feed: f.id }}
                title={f.last_error ?? f.title}
                className="flex items-baseline justify-between rounded px-2 py-0.5 text-[13px] text-zinc-600 hover:bg-zinc-200/60 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                <span className="truncate">
                  {f.error_count > 0 && (
                    <span className="mr-1 text-amber-500" aria-label="fetch error">
                      ●
                    </span>
                  )}
                  {f.title}
                </span>
                {f.unread_count > 0 && (
                  <span className="ml-2 tabular-nums text-zinc-400">{f.unread_count}</span>
                )}
              </Link>
            ))}
          </div>
        );
      })}
    </div>
  );
}

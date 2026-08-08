import { createFileRoute, Link } from "@tanstack/react-router";
import { River } from "#/components/River";
import type { RiverView } from "#/lib/api";

interface HomeSearch {
  view?: RiverView;
  group?: string;
  feed?: number;
  tag?: string;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): HomeSearch => ({
    view: search.view === "all" || search.view === "saved" ? search.view : undefined,
    group: typeof search.group === "string" ? search.group : undefined,
    feed: typeof search.feed === "number" ? search.feed : undefined,
    tag: typeof search.tag === "string" ? search.tag : undefined,
  }),
  component: StartPage,
});

/**
 * The start page: a single home surface of incoming information. The feed
 * river is its first panel; future panels (vault activity, reminders…) join
 * the same stack.
 */
function StartPage() {
  const search = Route.useSearch();
  const view: RiverView = search.view ?? "unread";

  return (
    <div className="mx-auto max-w-3xl px-6 py-6">
      <Panel
        title="Reading"
        controls={
          <>
            <FilterChips search={search} />
            <ViewTabs view={view} search={search} />
          </>
        }
      >
        <River filters={{ view, group: search.group, feed: search.feed, tag: search.tag }} />
      </Panel>
    </div>
  );
}

/** The minimal panel contract: a titled region on the home surface. */
function Panel({
  title,
  controls,
  children,
}: {
  title: string;
  controls?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header className="mb-2 flex flex-wrap items-center gap-3">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        <div className="ml-auto flex items-center gap-3">{controls}</div>
      </header>
      {children}
    </section>
  );
}

function ViewTabs({ view, search }: { view: RiverView; search: Record<string, unknown> }) {
  const tabs: { key: RiverView; label: string }[] = [
    { key: "unread", label: "Unread" },
    { key: "all", label: "All" },
    { key: "saved", label: "Saved" },
  ];
  return (
    <nav className="flex gap-1 rounded bg-zinc-100 p-0.5 dark:bg-zinc-900">
      {tabs.map((t) => (
        <Link
          key={t.key}
          to="/"
          search={{ ...search, view: t.key === "unread" ? undefined : t.key }}
          className={`rounded px-2 py-0.5 text-xs ${
            view === t.key
              ? "bg-white font-medium shadow-sm dark:bg-zinc-700"
              : "text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
          }`}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

/** Active group/feed/tag filters, each dismissible. */
function FilterChips({ search }: { search: HomeSearch }) {
  const chips: { label: string; clear: Partial<HomeSearch> }[] = [];
  if (search.group) chips.push({ label: search.group, clear: { group: undefined } });
  if (search.feed) chips.push({ label: `feed #${search.feed}`, clear: { feed: undefined } });
  if (search.tag) chips.push({ label: `#${search.tag}`, clear: { tag: undefined } });
  if (chips.length === 0) return null;
  return (
    <div className="flex gap-1.5">
      {chips.map((c) => (
        <Link
          key={c.label}
          to="/"
          search={{ ...search, ...c.clear }}
          className="rounded-full border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300"
          title="clear filter"
        >
          {c.label} ✕
        </Link>
      ))}
    </div>
  );
}

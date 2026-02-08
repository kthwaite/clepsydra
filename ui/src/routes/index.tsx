import { createFileRoute, Link } from "@tanstack/react-router";
import { useStats, useTags } from "#/api/index";
import { usePages } from "#/api/pages";
import { StatCard } from "#/components/StatCard";
import { TagCloud } from "#/components/TagCloud";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  const { data: stats } = useStats();
  const { data: tags } = useTags();
  const { data: pagesData } = usePages();
  const pages = pagesData?.items;

  return (
    <div className="mx-auto max-w-3xl px-8 py-6">
      <h1 className="mb-6 text-2xl font-bold">Vault</h1>

      {stats && (
        <div className="mb-8 grid grid-cols-3 gap-4">
          <StatCard label="Pages" value={stats.pages} />
          <StatCard label="Links" value={stats.links_total} />
          <StatCard label="Tags" value={stats.tags} />
        </div>
      )}

      {stats && stats.links_unresolved > 0 && (
        <div className="mb-8 border border-destructive p-4">
          <p className="text-sm font-bold text-destructive">
            {stats.links_unresolved} unresolved link
            {stats.links_unresolved !== 1 ? "s" : ""}
          </p>
        </div>
      )}

      {tags && tags.length > 0 && (
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
            Tags
          </h2>
          <TagCloud tags={tags} />
        </section>
      )}

      {pages && pages.length > 0 && (
        <section>
          <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
            All Pages ({pagesData.total})
          </h2>
          <ul className="space-y-px">
            {pages.slice(0, 20).map((p) => (
              <li key={p.id}>
                <Link
                  to="/pages/$"
                  params={{ _splat: p.path }}
                  className="block border-b border-border px-2 py-2 text-sm hover:bg-accent"
                >
                  <span className="font-medium">{p.title || p.path}</span>
                  {p.title && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {p.path}
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

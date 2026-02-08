import { Link } from "@tanstack/react-router";
import { usePages } from "#/api/pages";

export function PageList() {
  const { data: pages, isLoading, error } = usePages();

  if (isLoading) {
    return (
      <p className="px-2 py-1 text-xs text-muted-foreground">Loading...</p>
    );
  }
  if (error) {
    return (
      <p className="px-2 py-1 text-xs text-destructive">Failed to load pages</p>
    );
  }
  if (!pages || pages.length === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">No pages</p>;
  }

  return (
    <ul className="space-y-px">
      {pages.map((page) => (
        <li key={page.id}>
          <Link
            to="/pages/$"
            params={{ _splat: page.path }}
            className="block truncate px-2 py-1 text-sm text-foreground hover:bg-accent"
            activeProps={{ className: "bg-accent font-medium" }}
          >
            {page.title || page.path}
          </Link>
        </li>
      ))}
    </ul>
  );
}

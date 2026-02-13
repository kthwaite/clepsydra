import type { PageMeta } from "#/api/types";

interface PageHeaderProps {
  title: string | null | undefined;
  path: string;
  meta: PageMeta;
}

export function PageHeader({ title, path, meta }: PageHeaderProps) {
  const tags = Array.isArray(meta.tags) ? meta.tags : [];

  return (
    <div className="border-b border-border pb-4">
      <h1 className="font-heading text-2xl font-bold">{title || path}</h1>
      <p className="mt-1 text-sm text-muted-foreground">{path}</p>
      {tags.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {tags.map((tag) => (
            <span
              key={tag}
              className="border border-border bg-muted px-2 py-0.5 text-xs"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

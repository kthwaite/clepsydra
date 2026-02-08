import type { TagCount } from "#/api/types";

interface TagCloudProps {
  tags: TagCount[];
}

export function TagCloud({ tags }: TagCloudProps) {
  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span key={t.tag} className="border border-border px-2 py-0.5 text-xs">
          {t.tag}
          <span className="ml-1 text-muted-foreground">{t.count}</span>
        </span>
      ))}
    </div>
  );
}

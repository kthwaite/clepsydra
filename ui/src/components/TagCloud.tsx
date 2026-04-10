import type { TagCount } from "#/api/types";
import { Badge } from "#/components/ui/badge";

interface TagCloudProps {
  tags: TagCount[];
}

export function TagCloud({ tags }: TagCloudProps) {
  if (tags.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <Badge key={t.tag} className="font-sans tracking-normal normal-case">
          {t.tag}
          <span className="ml-1 text-muted-foreground">{t.count}</span>
        </Badge>
      ))}
    </div>
  );
}

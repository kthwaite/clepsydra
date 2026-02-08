import type { BacklinkEntry } from "#/api/types";
import { useOpenTab } from "#/hooks/useOpenTab";

interface BacklinksPanelProps {
  backlinks: BacklinkEntry[];
}

export function BacklinksPanel({ backlinks }: BacklinksPanelProps) {
  const openTab = useOpenTab();

  if (backlinks.length === 0) return null;

  return (
    <section className="mt-8 border-t border-border pt-6">
      <h2 className="mb-3 text-sm font-bold uppercase tracking-widest text-muted-foreground">
        Backlinks ({backlinks.length})
      </h2>
      <ul className="space-y-3">
        {backlinks.map((bl, i) => (
          <li key={`${bl.source_id}-${i}`} className="border border-border p-3">
            <a
              href={`/pages/${bl.source_path}`}
              onClick={(e) => {
                e.preventDefault();
                openTab(
                  "page",
                  bl.source_path,
                  bl.source_title || bl.source_path,
                );
              }}
              className="font-medium underline decoration-1 underline-offset-2 hover:decoration-2"
            >
              {bl.source_title || bl.source_path}
            </a>
            {bl.context && (
              <p className="mt-1 text-sm text-muted-foreground">{bl.context}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

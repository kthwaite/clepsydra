import { useBaseView, usePropertyCommit } from "#/api/bases";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";

export interface ReadingRow {
  id: string;
  path: string;
  title?: string | null;
  author?: string | null;
  progress?: number | null;
  pages?: number | null;
}

const PROGRESS_STEP = 10;

/**
 * The "Reading Continues" panel: BOOK pages in flight, from the reading
 * base's `Continues` view. The progress affordance nudges `progress` by a
 * page-count step via the property patch — the same write path as the base
 * table and Neovim.
 */
export function ReadingContinues({
  rows,
  onOpen,
  onAdvance,
}: {
  rows: ReadingRow[];
  onOpen: (row: ReadingRow) => void;
  onAdvance: (row: ReadingRow, nextProgress: number) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="col-span-12 border border-rule bg-paper-2">
      <div className="flex items-center justify-between border-b border-rule bg-paper px-3.5 py-2">
        <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
          Reading continues
        </span>
        <span className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
          {rows.length} in flight
        </span>
      </div>
      <div className="flex flex-col">
        {rows.map((row) => {
          const pages = row.pages ?? 0;
          const progress = row.progress ?? 0;
          const pct =
            pages > 0 ? Math.min(100, Math.round((progress / pages) * 100)) : 0;
          const next =
            pages > 0
              ? Math.min(pages, progress + PROGRESS_STEP)
              : progress + PROGRESS_STEP;
          return (
            <div
              key={row.id}
              className="grid grid-cols-[1fr_140px_auto] items-center gap-3 border-b border-dotted border-rule-soft px-3.5 py-2 last:border-b-0"
            >
              <button
                type="button"
                onClick={() => onOpen(row)}
                className="cursor-pointer overflow-hidden text-left"
              >
                <span className="block overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[14px] text-ink">
                  {row.title ?? row.path}
                </span>
                {row.author && (
                  <span className="cl-mono block text-[9px] uppercase tracking-[0.14em] text-ink-mute">
                    {row.author}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-2">
                <span className="relative block h-[6px] flex-1 bg-rule-soft">
                  <span
                    className="absolute inset-y-0 left-0 bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="cl-mono text-[9px] tabular-nums text-ink-mute">
                  {pages > 0 ? `${progress}/${pages}` : `p.${progress}`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onAdvance(row, next)}
                className={cn(
                  "cl-mono border border-rule px-2 py-0.5 text-[10px] tracking-[0.08em] text-ink-2",
                  "hover:border-accent hover:text-accent",
                )}
                aria-label={`Advance ${row.title ?? row.path} by ${PROGRESS_STEP} pages`}
              >
                +{PROGRESS_STEP}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function toNumber(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function toText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Wired panel: consumes `GET /bases/reading/views/continues` and issues
 * `progress` property patches. Renders nothing when the vault carries no
 * reading base (the query 404s) or nothing is in flight.
 */
export function ReadingContinuesPanel() {
  const view = useBaseView("reading", "Continues");
  const commit = usePropertyCommit();
  const openTab = useOpenTab();

  const rows: ReadingRow[] =
    view.data?.shape === "flat"
      ? view.data.rows.map((row) => ({
          id: row.id,
          path: row.path,
          title: row.title,
          author: toText(row.columns.author),
          progress: toNumber(row.columns.progress),
          pages: toNumber(row.columns.pages),
        }))
      : [];

  return (
    <ReadingContinues
      rows={rows}
      onOpen={(row) => openTab("page", row.path, row.title ?? row.path)}
      onAdvance={(row, nextProgress) => {
        void commit(row, "progress", nextProgress);
      }}
    />
  );
}

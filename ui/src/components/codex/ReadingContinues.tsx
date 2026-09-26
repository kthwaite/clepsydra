import { useBaseView, usePropertyCommit } from "#/api/bases";
import { Tick } from "#/components/codex/Tick";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

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
    <section
      aria-label="Reading continues"
      className="col-span-12 flex flex-col gap-[22px]"
    >
      <div className="flex items-center gap-3">
        <Tick />
        <h2 className="font-serif text-[22px] italic leading-none text-ink">
          Reading continues
        </h2>
        <span className="text-[13px] text-mute">{rows.length} in flight</span>
      </div>
      <div className="flex max-w-[900px] flex-col gap-5 pl-[19px]">
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
              className="grid grid-cols-[minmax(0,1fr)_minmax(0,220px)_auto] items-center gap-6"
            >
              <button
                type="button"
                onClick={() => onOpen(row)}
                className={cn(
                  "flex min-w-0 cursor-pointer flex-col gap-0.5 rounded-sm text-left",
                  FOCUS_RING_NATIVE,
                )}
              >
                <span className="truncate font-serif text-[23px] leading-[1.15] text-ink">
                  {row.title ?? row.path}
                </span>
                {row.author && (
                  <span className="block truncate text-[13px] text-mute">
                    {row.author}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-3">
                <span
                  data-progress-track
                  className="relative block h-1 flex-1 overflow-hidden rounded-full bg-sink"
                >
                  <span
                    className="absolute inset-y-0 left-0 rounded-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </span>
                <span className="text-[13px] tabular-nums text-mute">
                  {pages > 0 ? `${progress}/${pages}` : `p.${progress}`}
                </span>
              </div>
              <button
                type="button"
                onClick={() => onAdvance(row, next)}
                className="cl-btn"
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
/** Rows of the reading base's `Continues` view; empty when the base is
 *  missing or not flat. */
export function useReadingRows(): ReadingRow[] {
  const view = useBaseView("reading", "Continues");
  return view.data?.shape === "flat"
    ? view.data.rows.map((row) => ({
        id: row.id,
        path: row.path,
        title: row.title,
        author: toText(row.columns.author),
        progress: toNumber(row.columns.progress),
        pages: toNumber(row.columns.pages),
      }))
    : [];
}

export function ReadingContinuesPanel() {
  const rows = useReadingRows();
  const commit = usePropertyCommit();
  const openTab = useOpenTab();

  return (
    <ReadingContinues
      rows={rows}
      onOpen={(row) => openTab("page", row.path, row.title ?? row.path)}
      onAdvance={(row, nextProgress) => {
        void commit(row, "progress", nextProgress).catch(() => undefined);
      }}
    />
  );
}

import { useSyncConflicts } from "#/api/index";
import { Button } from "#/components/ui/button";
import { useOpenTab } from "#/hooks/useOpenTab";

export function ConflictsPanel() {
  const conflictsQuery = useSyncConflicts();
  const openTab = useOpenTab();
  const items = conflictsQuery.data?.items ?? [];
  const total = conflictsQuery.data?.total ?? 0;

  return (
    <main className="mx-auto flex h-full min-h-screen w-full max-w-[1440px] flex-col bg-paper text-ink">
      <header className="border-b border-rule bg-paper-2 px-3 py-4 md:px-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
              Vault sync / merge residue
            </p>
            <h1 className="mt-1 text-2xl font-black tracking-tight">
              Conflicts
            </h1>
          </div>
          <p className="cl-mono text-[10px] tabular-nums text-ink-mute">
            {total} {total === 1 ? "copy" : "copies"}
          </p>
        </div>
        <p className="mt-3 max-w-2xl text-sm text-ink-2">
          Each entry is a page another device changed at the same time as this
          one; the local version kept its place, the other version was saved as
          a copy. Fold anything you want to keep into the original, then delete
          the copy.
        </p>
      </header>

      {conflictsQuery.isPending ? (
        <div
          role="status"
          className="cl-mono flex flex-1 items-center justify-center p-8 text-[11px] uppercase tracking-[0.18em] text-ink-mute"
        >
          Loading conflict copies…
        </div>
      ) : conflictsQuery.isError ? (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center p-8 text-sm text-hot"
        >
          Could not load conflict copies.
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <p className="text-sm font-semibold">
            No conflict copies. Merges are clean.
          </p>
        </div>
      ) : (
        <ul
          aria-label="Conflict copies"
          className="min-h-0 flex-1 divide-y divide-rule overflow-y-auto"
        >
          {items.map((item) => (
            <li
              key={item.path}
              className="flex flex-wrap items-start justify-between gap-3 px-3 py-4 md:px-5"
            >
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-sm font-semibold"
                  title={item.title ?? item.path}
                >
                  {item.title ?? item.path}
                </p>
                <p
                  className="cl-mono mt-1 truncate text-[11px] text-ink-mute"
                  title={item.path}
                >
                  {item.path}
                </p>
                <p className="mt-2 text-xs text-ink-2">
                  conflicted with{" "}
                  <span className="cl-mono">{item.original}</span>
                  {item.original_title ? ` (${item.original_title})` : null}
                </p>
                {!item.original_exists ? (
                  <p className="mt-1 text-xs text-warn">
                    original missing — it was deleted or moved after the merge
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onPress={() =>
                    openTab("page", item.path, item.title ?? item.path)
                  }
                >
                  Open copy
                </Button>
                {item.original_exists ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onPress={() =>
                      openTab(
                        "page",
                        item.original,
                        item.original_title ?? item.original,
                      )
                    }
                  >
                    Open original
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

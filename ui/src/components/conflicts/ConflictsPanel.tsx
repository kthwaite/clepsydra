import { useNavigate } from "@tanstack/react-router";
import { useSyncConflicts } from "#/api/index";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
import { useOpenTab } from "#/hooks/useOpenTab";

export function ConflictsPanel() {
  const conflictsQuery = useSyncConflicts();
  const openTab = useOpenTab();
  const navigate = useNavigate();
  const items = conflictsQuery.data?.items ?? [];
  const total = conflictsQuery.data?.total ?? 0;

  return (
    <main className="mx-auto flex h-full min-h-0 w-full max-w-[1440px] flex-col bg-ground text-ink">
      <header className="px-4 pt-6 pb-2 md:px-10">
        <div className="flex flex-wrap items-end justify-between gap-x-7 gap-y-3">
          <div className="flex min-w-0 flex-col gap-2.5">
            <div className="flex items-center gap-2.5">
              <Tick />
              <p className="font-serif text-[19px] italic leading-none text-mute">
                Vault sync
              </p>
            </div>
            <h1 className="m-0 font-serif text-[40px] font-normal leading-none md:text-[56px]">
              Conflicts
            </h1>
          </div>
          <p className="pb-0.5 text-[14px] tabular-nums text-mute">
            {total} {total === 1 ? "copy" : "copies"}
          </p>
        </div>
        <p className="mt-4 max-w-2xl text-[14px] leading-[1.55] text-ink-2">
          Each entry is a page another device changed at the same time as this
          one; the local version kept its place, the remote version was saved
          as a copy. Compare the two to pick what to keep, hunk by hunk;
          resolving writes the result into the original and moves the copy to
          the rubbish bin.
        </p>
      </header>

      {conflictsQuery.isPending ? (
        <div
          role="status"
          className="flex flex-1 items-center justify-center p-8 text-[13px] text-mute"
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
          <p className="font-serif text-[22px] italic text-mute">
            No conflict copies. Merges are clean.
          </p>
        </div>
      ) : (
        <ul
          aria-label="Conflict copies"
          className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 py-4 md:px-7"
        >
          {items.map((item) => (
            <li
              key={item.path}
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl px-2 py-3 hover:bg-raise md:px-3"
            >
              <div className="min-w-0 flex-1">
                <p
                  className="truncate text-[15px] font-medium text-ink"
                  title={item.title ?? item.path}
                >
                  {item.title ?? item.path}
                </p>
                <p
                  className="mt-1 truncate text-[13px] text-mute"
                  title={item.path}
                >
                  {item.path}
                </p>
                <p className="mt-1.5 truncate text-[13px] text-ink-2">
                  Conflicted with <span>{item.original}</span>
                  {item.original_title ? ` (${item.original_title})` : null}
                </p>
                {!item.original_exists ? (
                  <p className="mt-1 text-[13px] text-warn">
                    Original missing — it was deleted or moved after the merge
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                {item.original_exists ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    onPress={() =>
                      void navigate({
                        to: "/conflicts/compare/$",
                        params: { _splat: item.path },
                      })
                    }
                  >
                    Compare
                  </Button>
                ) : null}
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

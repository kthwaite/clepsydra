import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { formatApiError, isApiConflict } from "#/api/error";
import {
  type EmptyRubbishResponse,
  type RubbishItemSummary,
  type RubbishListEntry,
  useEmptyRubbish,
  usePurgeRubbishItem,
  useRestoreRubbishItem,
  useRubbishItem,
  useRubbishList,
} from "#/api/rubbish";
import { PreviewMarkdown } from "#/components/codex/PreviewMarkdown";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";

type Confirmation =
  | { kind: "purge"; item: RubbishItemSummary }
  | { kind: "empty"; count: number }
  | null;

interface RestoredPage {
  path: string;
  title: string;
}

const deletedAtFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "UTC",
  timeZoneName: "short",
});

function formatDeletedAt(value: string): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.valueOf())
    ? "Deletion time unavailable"
    : deletedAtFormatter.format(timestamp);
}

function RubbishRow({
  entry,
  selected,
  onSelect,
}: {
  entry: RubbishListEntry;
  selected: boolean;
  onSelect: (itemId: string) => void;
}) {
  if (entry.status === "invalid") {
    return (
      <li className="border-b border-hot/40 bg-hot/5 px-4 py-3">
        <p className="cl-mono text-[10px] font-bold uppercase tracking-[0.14em] text-hot">
          Invalid rubbish item
        </p>
        <p className="mt-1 break-all font-mono text-[10px] text-ink-mute">
          {entry.item_id}
        </p>
        <p className="mt-2 text-xs leading-relaxed text-ink-2">{entry.error}</p>
      </li>
    );
  }

  const { item } = entry;
  return (
    <li className="border-b border-rule-soft">
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(item.item_id)}
        className={cn(
          "group block min-h-20 w-full px-4 py-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent",
          selected ? "bg-highlight" : "hover:bg-paper-2",
        )}
        aria-label={`${item.title}, ${item.original_path}`}
      >
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0">
            <span className="block truncate text-sm font-bold text-ink">
              {item.title}
            </span>
            <span className="cl-mono mt-1 block truncate text-[10px] text-ink-mute">
              {item.original_path}
            </span>
          </span>
          <span className="cl-mono shrink-0 border border-rule px-1.5 py-0.5 text-[9px] uppercase tracking-[0.1em] text-ink-mute">
            {item.kind}
          </span>
        </span>
        <span className="cl-mono mt-2 block text-[9px] tabular-nums text-ink-faint">
          Deleted {formatDeletedAt(item.deleted_at)}
        </span>
      </button>
    </li>
  );
}

function DetailMetadata({ item }: { item: RubbishItemSummary }) {
  const fields = [
    ["Original path", item.original_path],
    ["Page ID", item.page_id],
    ["Kind", item.kind],
    ["Deleted", formatDeletedAt(item.deleted_at)],
  ];
  return (
    <dl className="grid border-y border-rule-soft sm:grid-cols-2">
      {fields.map(([label, value]) => (
        <div key={label} className="border-b border-rule-soft px-4 py-3 even:sm:border-l last:border-b-0 sm:[&:nth-last-child(2)]:border-b-0">
          <dt className="cl-mono text-[9px] uppercase tracking-[0.16em] text-ink-mute">
            {label}
          </dt>
          <dd className="mt-1 break-words font-mono text-[11px] text-ink-2">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RubbishBin() {
  const listQuery = useRubbishList();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [restoredPage, setRestoredPage] = useState<RestoredPage | null>(null);
  const [emptyOutcomes, setEmptyOutcomes] = useState<
    EmptyRubbishResponse["outcomes"] | null
  >(null);
  const detailQuery = useRubbishItem(selectedId);
  const restore = useRestoreRubbishItem();
  const purge = usePurgeRubbishItem();
  const empty = useEmptyRubbish();
  const openTab = useOpenTab();
  const mobile = useMobileLayout();

  const entries = (listQuery.data ?? []).filter(
    (entry) =>
      entry.status === "invalid" || !hiddenIds.has(entry.item.item_id),
  );
  const validItems = entries.flatMap((entry) =>
    entry.status === "valid" ? [entry.item] : [],
  );
  const selectedSummary = selectedId
    ? (validItems.find((item) => item.item_id === selectedId) ?? null)
    : null;

  function hideItems(itemIds: readonly string[]) {
    setHiddenIds((current) => {
      const next = new Set(current);
      for (const itemId of itemIds) next.add(itemId);
      return next;
    });
  }

  async function restoreSelected() {
    if (!selectedSummary) return;
    setActionError(null);
    setRestoredPage(null);
    try {
      const result = await restore.mutateAsync(selectedSummary.item_id);
      hideItems([result.item_id]);
      setSelectedId(null);
      setRestoredPage({ path: result.path, title: selectedSummary.title });
    } catch (error) {
      const fallback = isApiConflict(error)
        ? `The original path ${selectedSummary.original_path} is occupied. Move or rename the current page, then restore again.`
        : "This item could not be restored.";
      setActionError(formatApiError(error, fallback));
    }
  }

  async function confirmPurge(item: RubbishItemSummary) {
    setActionError(null);
    try {
      const result = await purge.mutateAsync(item.item_id);
      hideItems([result.item_id]);
      setSelectedId(null);
      setConfirmation(null);
    } catch (error) {
      setConfirmation(null);
      setActionError(
        formatApiError(error, `${item.title} was not deleted permanently.`),
      );
    }
  }

  async function confirmEmpty() {
    setActionError(null);
    setEmptyOutcomes(null);
    try {
      const result = await empty.mutateAsync();
      setEmptyOutcomes(result.outcomes);
      hideItems(
        result.outcomes.flatMap((outcome) =>
          outcome.status === "purged" ? [outcome.item.item_id] : [],
        ),
      );
      if (
        selectedId &&
        result.outcomes.some(
          (outcome) =>
            outcome.status === "purged" && outcome.item.item_id === selectedId,
        )
      ) {
        setSelectedId(null);
      }
      setConfirmation(null);
    } catch (error) {
      setConfirmation(null);
      setActionError(
        formatApiError(error, "The Rubbish Bin could not be emptied."),
      );
    }
  }

  return (
    <main className="mx-auto flex h-full min-h-screen w-full max-w-[1440px] flex-col bg-paper text-ink">
      <header className="border-b border-rule bg-paper-2 px-4 py-4 md:px-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
              Vault lifecycle / retained deletions
            </p>
            <h1 className="mt-1 text-2xl font-black tracking-tight">
              Rubbish Bin
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <p className="cl-mono text-[10px] tabular-nums text-ink-mute">
              {validItems.length} {validItems.length === 1 ? "item" : "items"}
            </p>
            <Button
              size="sm"
              variant="danger"
              isDisabled={validItems.length === 0 || empty.isPending}
              onPress={() =>
                setConfirmation({ kind: "empty", count: validItems.length })
              }
            >
              Empty Rubbish Bin
            </Button>
          </div>
        </div>
      </header>

      {actionError ? (
        <div role="alert" className="border-b border-hot bg-hot/5 px-4 py-3 text-sm text-hot">
          {actionError}
        </div>
      ) : null}
      {restoredPage ? (
        <div role="status" className="flex flex-wrap items-center justify-between gap-3 border-b border-cool bg-paper-2 px-4 py-3 text-sm text-ink-2">
          <span>
            Restored to <code>{restoredPage.path}</code>.
          </span>
          <Button
            size="sm"
            variant="secondary"
            onPress={() =>
              openTab("page", restoredPage.path, restoredPage.title)
            }
          >
            Open restored page
          </Button>
        </div>
      ) : null}
      {emptyOutcomes ? (
        <section aria-labelledby="empty-outcomes-heading" className="border-b border-rule bg-paper-2 px-4 py-3">
          <h2 id="empty-outcomes-heading" className="cl-mono text-[10px] font-bold uppercase tracking-[0.16em]">
            Empty Bin results
          </h2>
          <ol className="mt-2 space-y-1">
            {emptyOutcomes.map((outcome, index) => (
              <li
                key={`${outcome.status === "purged" ? outcome.item.item_id : outcome.item_id}-${index}`}
                aria-label={`Empty outcome ${index + 1}`}
                className={cn(
                  "grid gap-x-3 border-l-2 px-3 py-2 text-xs sm:grid-cols-[minmax(0,1fr)_auto]",
                  outcome.status === "purged"
                    ? "border-cool bg-paper"
                    : "border-hot bg-hot/5",
                )}
              >
                {outcome.status === "purged" ? (
                  <>
                    <code className="break-all">{outcome.item.original_path}</code>
                    <span className="cl-mono text-[9px] uppercase tracking-[0.1em] text-ink-mute">
                      Deleted permanently
                    </span>
                  </>
                ) : (
                  <>
                    <code className="break-all">{outcome.item_id}</code>
                    <span className="text-hot">{outcome.error}</span>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {listQuery.isPending ? (
        <div role="status" className="cl-mono flex flex-1 items-center justify-center p-8 text-[11px] uppercase tracking-[0.18em] text-ink-mute">
          Loading Rubbish Bin…
        </div>
      ) : listQuery.isError ? (
        <div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm text-hot">
          <p>{formatApiError(listQuery.error, "The Rubbish Bin could not load.")}</p>
          <Button size="sm" variant="secondary" onPress={() => void listQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : entries.length === 0 ? (
        <div role="status" className="flex flex-1 items-center justify-center p-8 text-center">
          <div>
            <p className="text-sm font-semibold">Rubbish Bin is empty.</p>
            <p className="mt-1 text-xs text-ink-mute">
              Deleted pages retained for recovery will appear here.
            </p>
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(18rem,0.78fr)_minmax(24rem,1.22fr)]">
          {(!mobile || selectedId === null) ? (
            <section aria-label="Rubbish ledger" className="min-h-0 overflow-y-auto border-rule md:border-r">
              <ul>{entries.map((entry) => (
                <RubbishRow
                  key={entry.status === "valid" ? entry.item.item_id : `invalid:${entry.item_id}`}
                  entry={entry}
                  selected={entry.status === "valid" && entry.item.item_id === selectedId}
                  onSelect={(itemId) => {
                    setActionError(null);
                    setRestoredPage(null);
                    setSelectedId(itemId);
                  }}
                />
              ))}</ul>
            </section>
          ) : null}

          {(!mobile || selectedId !== null) ? (
            <section aria-label="Rubbish item detail" className="min-h-0 overflow-y-auto bg-paper">
              {selectedId === null ? (
                <div className="flex h-full min-h-64 items-center justify-center p-8 text-center">
                  <div>
                    <p className="text-sm font-semibold">Select a retained page.</p>
                    <p className="mt-1 text-xs text-ink-mute">
                      Inspect its stored metadata and read-only preview before acting.
                    </p>
                  </div>
                </div>
              ) : detailQuery.isPending ? (
                <div role="status" className="cl-mono flex min-h-64 items-center justify-center p-8 text-[11px] uppercase tracking-[0.18em] text-ink-mute">
                  Loading retained page…
                </div>
              ) : detailQuery.isError ? (
                <div role="alert" className="flex min-h-64 items-center justify-center p-8 text-center text-sm text-hot">
                  {formatApiError(detailQuery.error, "This retained page could not load.")}
                </div>
              ) : detailQuery.data ? (
                <article>
                  <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-4 md:px-5">
                    <div className="min-w-0">
                      {mobile ? (
                        <Button size="sm" variant="ghost" className="mb-3" onPress={() => setSelectedId(null)}>
                          <ArrowLeft aria-hidden /> Back to Rubbish Bin
                        </Button>
                      ) : null}
                      <p className="cl-mono text-[9px] uppercase tracking-[0.18em] text-ink-mute">
                        Retained page / read only
                      </p>
                      <h2 className="mt-1 break-words text-xl font-black tracking-tight">
                        {detailQuery.data.item.title}
                      </h2>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        isDisabled={restore.isPending || purge.isPending}
                        onPress={() => void restoreSelected()}
                      >
                        <RotateCcw aria-hidden /> Restore
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        isDisabled={restore.isPending || purge.isPending}
                        onPress={() =>
                          setConfirmation({ kind: "purge", item: detailQuery.data.item })
                        }
                      >
                        <Trash2 aria-hidden /> Delete permanently
                      </Button>
                    </div>
                  </div>
                  <DetailMetadata item={detailQuery.data.item} />
                  <section aria-labelledby="stored-preview-heading" className="px-4 py-5 md:px-5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <h3 id="stored-preview-heading" className="cl-mono text-[10px] font-bold uppercase tracking-[0.16em]">
                        Stored body preview
                      </h3>
                      {detailQuery.data.preview.truncated ? (
                        <span className="cl-mono text-[9px] uppercase tracking-[0.1em] text-warn">
                          Preview is truncated
                        </span>
                      ) : null}
                    </div>
                    <div className="pointer-events-none mt-3 max-h-96 overflow-hidden border-l-2 border-rule bg-paper-2 px-4 py-3" aria-readonly="true">
                      {detailQuery.data.preview.encrypted ? (
                        <p className="text-xs text-ink-mute">
                          This retained body is encrypted and is not disclosed in the preview.
                        </p>
                      ) : (
                        <PreviewMarkdown content={detailQuery.data.preview.body} />
                      )}
                    </div>
                  </section>
                </article>
              ) : null}
            </section>
          ) : null}
        </div>
      )}

      <Dialog
        isOpen={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmation(null);
        }}
        title={confirmation?.kind === "purge" ? "Delete permanently" : "Empty Rubbish Bin"}
        description={
          confirmation?.kind === "purge"
            ? `Delete “${confirmation.item.title}” and its retained content permanently? This cannot be undone.`
            : confirmation?.kind === "empty"
              ? `Permanently delete every valid item currently in the Rubbish Bin (${confirmation.count} ${confirmation.count === 1 ? "item" : "items"})? Every item will be attempted and this cannot be undone.`
              : undefined
        }
        footer={
          <>
            <Button variant="secondary" onPress={() => setConfirmation(null)}>
              Cancel
            </Button>
            {confirmation?.kind === "purge" ? (
              <Button variant="danger" isDisabled={purge.isPending} onPress={() => void confirmPurge(confirmation.item)}>
                Delete permanently
              </Button>
            ) : confirmation?.kind === "empty" ? (
              <Button variant="danger" isDisabled={empty.isPending} onPress={() => void confirmEmpty()}>
                Empty Rubbish Bin permanently
              </Button>
            ) : null}
          </>
        }
      >
        <p className="text-sm leading-relaxed text-ink-2">
          {confirmation?.kind === "purge"
            ? "The archived body, metadata, and retained attachments for this page will be removed."
            : "Successful deletions disappear immediately. Any failures remain in the Bin and are reported in their original order."}
        </p>
      </Dialog>
    </main>
  );
}

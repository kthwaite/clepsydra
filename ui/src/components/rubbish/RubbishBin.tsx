import { ArrowLeft, RotateCcw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { Tick } from "#/components/codex/Tick";
import { FilterBar } from "#/components/filters/FilterBar";
import { Button } from "#/components/ui/button";
import { Dialog } from "#/components/ui/dialog";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import {
  applyClientFilter,
  EMPTY_FILTER_STATE,
  type FilterField,
  type FilterState,
  isFilterActive,
} from "#/lib/filters/model";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { KINDS, type Kind, kindDisplayLabel } from "#/lib/kind";
import { formatCapturedAt } from "#/lib/time";

type Confirmation =
  | { kind: "purge"; item: RubbishItemSummary }
  | { kind: "empty" }
  | null;

interface RestoredPage {
  path: string;
  title: string;
}

/** Local "13 Aug 2026, 15:30" with fixed month names. */
function formatDeletedAt(value: string): string {
  return Number.isNaN(new Date(value).valueOf())
    ? "Deletion time unavailable"
    : formatCapturedAt(value);
}

/** Retained items store `kind` as a bare string, not the typed `Kind` union
 * (see RubbishItemSummary in schema.d.ts). A known kind reads through
 * `kindDisplayLabel`; an unrecognised one — e.g. from a stale item predating
 * a kind — is sentence-cased here rather than crashing the lookup. */
function kindText(kind: string): string {
  if ((KINDS as readonly string[]).includes(kind)) {
    return kindDisplayLabel(kind as Kind);
  }
  const words = kind.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Tick plus muted italic serif label (spec decision 6). */
function Eyebrow({
  id,
  as: Tag = "p",
  tick = "faint",
  children,
}: {
  id?: string;
  as?: "p" | "h2" | "h3";
  tick?: "live" | "faint";
  children: string;
}) {
  return (
    <Tag className="m-0 flex items-center gap-2.5 font-normal">
      <Tick variant={tick} />
      <span
        id={id}
        className="font-serif text-[19px] italic leading-none text-mute"
      >
        {children}
      </span>
    </Tag>
  );
}

/** Quiet destructive action: hot text on ground or raise, a 5% hot tint on
 *  hover — never hot on sink. */
const QUIET_DANGER =
  "h-10 px-5 text-hot data-[hovered]:bg-hot/5 data-[hovered]:text-hot data-[pressed]:bg-hot/5";

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
      <li className="flex flex-col gap-[5px] rounded-xl bg-hot/5 px-3.5 py-[13px]">
        <p className="flex items-center gap-2 text-[14.5px] font-medium text-hot">
          <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-hot" />
          Unreadable item
        </p>
        <p className="text-[12.5px] leading-relaxed text-ink-2">
          {entry.error}
        </p>
        <p className="break-all text-[12.5px] text-mute">{entry.item_id}</p>
      </li>
    );
  }

  const { item } = entry;
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={() => onSelect(item.item_id)}
        className={cn(
          "flex w-full flex-col gap-[5px] rounded-xl px-3.5 py-[13px] text-left transition-colors",
          FOCUS_RING_NATIVE,
          selected ? "bg-accent-tint" : "hover:bg-sink/60",
        )}
        aria-label={`${item.title}, ${item.original_path}`}
      >
        <span className="flex min-w-0 items-baseline gap-3">
          <span className="min-w-0 truncate text-[14.5px] font-medium text-ink">
            {item.title}
          </span>
          <span className="flex-1" />
          <span className="shrink-0 text-[12.5px] text-mute">
            {kindText(item.kind)}
          </span>
        </span>
        <span className="flex min-w-0 gap-2 text-[12.5px] text-mute">
          <span className="min-w-0 truncate">{item.original_path}</span>
          <span aria-hidden className="text-faint">
            ·
          </span>
          <time dateTime={item.deleted_at} className="shrink-0 tabular-nums">
            {formatDeletedAt(item.deleted_at)}
          </time>
        </span>
      </button>
    </li>
  );
}

function DetailMetadata({ item }: { item: RubbishItemSummary }) {
  const fields = [
    ["Original path", item.original_path],
    ["Kind", kindText(item.kind)],
    ["Deleted", formatDeletedAt(item.deleted_at)],
    ["Page ID", item.page_id],
  ];
  return (
    <dl className="mt-7 grid grid-cols-1 gap-x-7 gap-y-4 sm:grid-cols-2 md:pl-[17px] xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
      {fields.map(([label, value]) => (
        <div key={label} className="flex min-w-0 flex-col gap-1">
          <dt className="text-[12.5px] text-mute">{label}</dt>
          <dd className="text-[13.5px] text-ink [overflow-wrap:anywhere]">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function RubbishBin({
  filterState = EMPTY_FILTER_STATE,
  onFilterChange = () => {},
}: {
  filterState?: FilterState;
  onFilterChange?: (next: FilterState) => void;
} = {}) {
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
  const emptyOutcomesRef = useRef<HTMLElement>(null);
  const detailQuery = useRubbishItem(selectedId);
  const restore = useRestoreRubbishItem();
  const purge = usePurgeRubbishItem();
  const empty = useEmptyRubbish();
  const openTab = useOpenTab();
  const mobile = useMobileLayout();
  const lifecycleBusy = restore.isPending || purge.isPending || empty.isPending;
  const confirmationBusy =
    confirmation?.kind === "purge"
      ? purge.isPending
      : confirmation?.kind === "empty"
        ? empty.isPending
        : false;

  const entries = (listQuery.data ?? []).filter(
    (entry) => entry.status === "invalid" || !hiddenIds.has(entry.item.item_id),
  );
  const validEntries = entries.filter(
    (entry): entry is Extract<RubbishListEntry, { status: "valid" }> =>
      entry.status === "valid",
  );
  const validItems = validEntries.map((entry) => entry.item);
  const selectedSummary = selectedId
    ? (validItems.find((item) => item.item_id === selectedId) ?? null)
    : null;

  const filterFields: FilterField[] = [
    {
      id: "kind",
      kind: "single",
      label: "Kind",
      options: [...new Set(validItems.map((item) => item.kind))]
        .sort()
        .map((value) => ({ value, label: kindText(value) })),
    },
  ];

  const filterActive = isFilterActive(filterState);
  const filteredValidEntries = applyClientFilter(validEntries, filterState, {
    accessors: { kind: (entry) => [entry.item.kind] },
    textHay: (entry) => `${entry.item.title}\n${entry.item.original_path}`,
  });
  // R7: an active filter drops invalid ledger entries from the render
  // entirely (they carry no title/path/kind to match against); with no
  // filter, rendering is unchanged — the mixed valid+invalid order from the
  // API, minus optimistically hidden ids.
  const visibleEntries: RubbishListEntry[] = filterActive
    ? filteredValidEntries
    : entries;
  const hasAnyEntries = entries.length > 0;
  const showFilteredEmpty = hasAnyEntries && visibleEntries.length === 0;

  useEffect(() => {
    if (!emptyOutcomes) return;
    emptyOutcomesRef.current?.focus();
  }, [emptyOutcomes]);

  function hideItems(itemIds: readonly string[]) {
    setHiddenIds((current) => {
      const next = new Set(current);
      for (const itemId of itemIds) next.add(itemId);
      return next;
    });
  }

  async function restoreSelected() {
    if (!selectedSummary || lifecycleBusy) return;
    setActionError(null);
    setRestoredPage(null);
    try {
      const result = await restore.mutateAsync(selectedSummary.item_id);
      hideItems([result.item_id]);
      setSelectedId(null);
      setRestoredPage({ path: result.path, title: selectedSummary.title });
    } catch (error) {
      if (isApiConflict(error)) {
        const serverMessage = formatApiError(error, "Restore conflict.");
        const guidance = /occupied/i.test(serverMessage)
          ? `Move or rename the page at ${selectedSummary.original_path}, then restore again.`
          : "The item remains in the rubbish bin. Refresh the bin and retry.";
        setActionError(`${serverMessage} ${guidance}`);
        return;
      }
      setActionError(formatApiError(error, "This item could not be restored."));
    }
  }

  async function confirmPurge(item: RubbishItemSummary) {
    if (lifecycleBusy) return;
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
    if (lifecycleBusy) return;
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
        formatApiError(error, "The rubbish bin could not be emptied."),
      );
    }
  }

  return (
    <main className="mx-auto flex h-full min-h-screen w-full max-w-[1440px] flex-col bg-ground text-ink">
      <header className="flex flex-wrap items-end gap-x-7 gap-y-3 px-4 pt-8 md:px-10 md:pt-10">
        <div className="flex flex-col gap-2.5">
          <Eyebrow>Retained deletions</Eyebrow>
          <h1 className="m-0 font-serif text-[40px] font-normal leading-none tracking-[-0.015em] md:text-[56px]">
            Rubbish bin
          </h1>
        </div>
        <p className="pb-1.5 text-[14px] tabular-nums text-mute">
          {validItems.length} {validItems.length === 1 ? "item" : "items"} ·
          kept until you empty the bin
        </p>
        <span className="hidden flex-1 sm:block" />
        <Button
          variant="ghost"
          className={QUIET_DANGER}
          isDisabled={validItems.length === 0 || lifecycleBusy}
          onPress={() => {
            if (lifecycleBusy) return;
            setConfirmation({ kind: "empty" });
          }}
        >
          Empty rubbish bin…
        </Button>
      </header>

      {actionError ? (
        <div
          role="alert"
          className="mx-4 mt-6 rounded-xl bg-hot/5 px-4 py-3 text-[14px] text-hot md:mx-10"
        >
          {actionError}
        </div>
      ) : null}
      {restoredPage ? (
        <div
          role="status"
          className="mx-4 mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl bg-raise px-4 py-3 text-[14px] text-ink-2 md:mx-10"
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            Restored to{" "}
            <span className="font-medium text-ink">{restoredPage.path}</span>.
          </span>
          <Button
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
        <section
          ref={emptyOutcomesRef}
          aria-label="Empty Bin results"
          tabIndex={-1}
          className={cn(
            "mx-4 mt-6 rounded-2xl bg-raise px-5 py-4 md:mx-10",
            FOCUS_RING_NATIVE,
          )}
        >
          <Eyebrow as="h2" tick="live">
            Empty bin results
          </Eyebrow>
          <p
            role="status"
            aria-label="Empty Bin completion"
            aria-live="polite"
            className="mt-2 text-[13.5px] text-ink-2 md:pl-[17px]"
          >
            {
              emptyOutcomes.filter((outcome) => outcome.status === "purged")
                .length
            }{" "}
            deleted permanently;{" "}
            {
              emptyOutcomes.filter((outcome) => outcome.status === "failed")
                .length
            }{" "}
            failed.
          </p>
          <ol className="mt-3 flex flex-col gap-1 md:pl-[17px]">
            {emptyOutcomes.map((outcome, index) => (
              <li
                key={
                  outcome.status === "purged"
                    ? outcome.item.item_id
                    : outcome.item_id
                }
                aria-label={`Empty outcome ${index + 1}`}
                className={cn(
                  "grid gap-x-3 gap-y-0.5 rounded-[10px] px-3 py-2 text-[13px] sm:grid-cols-[minmax(0,1fr)_auto]",
                  outcome.status === "purged" ? "bg-ground" : "bg-hot/5",
                )}
              >
                {outcome.status === "purged" ? (
                  <>
                    <span className="min-w-0 break-all text-ink">
                      {outcome.item.original_path}
                    </span>
                    <span className="text-mute">Deleted permanently</span>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 break-all text-ink">
                      {outcome.item_id}
                    </span>
                    <span className="text-hot">{outcome.error}</span>
                  </>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {listQuery.isPending ? (
        <div
          role="status"
          className="flex flex-1 items-center justify-center p-8 text-[14px] text-mute"
        >
          Loading rubbish bin…
        </div>
      ) : listQuery.isError ? (
        <div
          role="alert"
          className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-[14px] text-hot"
        >
          <p>
            {formatApiError(listQuery.error, "The rubbish bin could not load.")}
          </p>
          <Button variant="secondary" onPress={() => void listQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <>
          {hasAnyEntries ? (
            <div className="px-4 pt-8 md:px-10">
              <FilterBar
                fields={filterFields}
                primaryFieldIds={["kind"]}
                state={filterState}
                onChange={onFilterChange}
                textPlaceholder="Title or original path…"
              />
            </div>
          ) : null}
          {!hasAnyEntries ? (
            <div
              role="status"
              className="flex flex-1 items-center justify-center p-8 text-center"
            >
              <div>
                <p className="text-[15px] font-medium text-ink">
                  Rubbish bin is empty.
                </p>
                <p className="mt-1 text-[13.5px] text-mute">
                  Deleted pages retained for recovery will appear here.
                </p>
              </div>
            </div>
          ) : showFilteredEmpty ? (
            <div
              role="status"
              className="flex flex-1 items-center justify-center p-8 text-[14px] text-mute"
            >
              No items match the filter
            </div>
          ) : (
            <div className="grid min-h-0 flex-1 gap-10 px-4 pt-7 pb-8 md:grid-cols-[minmax(18rem,456px)_minmax(0,1fr)] md:px-10">
              {!mobile || selectedId === null ? (
                <section
                  aria-label="Rubbish ledger"
                  className="min-h-0 overflow-y-auto md:-mx-3.5"
                >
                  <ul className="flex flex-col gap-1">
                    {visibleEntries.map((entry) => (
                      <RubbishRow
                        key={
                          entry.status === "valid"
                            ? entry.item.item_id
                            : `invalid:${entry.item_id}`
                        }
                        entry={entry}
                        selected={
                          entry.status === "valid" &&
                          entry.item.item_id === selectedId
                        }
                        onSelect={(itemId) => {
                          setActionError(null);
                          setRestoredPage(null);
                          setSelectedId(itemId);
                        }}
                      />
                    ))}
                  </ul>
                </section>
              ) : null}

              {!mobile || selectedId !== null ? (
                <section
                  aria-label="Rubbish item detail"
                  className="min-h-0 min-w-0 overflow-y-auto rounded-2xl bg-raise"
                >
                  {selectedId === null ? (
                    <div className="flex h-full min-h-64 items-center justify-center p-8 text-center">
                      <div>
                        <p className="text-[15px] font-medium text-ink">
                          Select a retained page.
                        </p>
                        <p className="mt-1 text-[13.5px] text-mute">
                          Inspect its stored metadata and read-only preview
                          before acting.
                        </p>
                      </div>
                    </div>
                  ) : detailQuery.isPending ? (
                    <div
                      role="status"
                      className="flex min-h-64 items-center justify-center p-8 text-[14px] text-mute"
                    >
                      Loading retained page…
                    </div>
                  ) : detailQuery.isError ? (
                    <div
                      role="alert"
                      className="flex min-h-64 items-center justify-center p-8 text-center text-[14px] text-hot"
                    >
                      {formatApiError(
                        detailQuery.error,
                        "This retained page could not load.",
                      )}
                    </div>
                  ) : detailQuery.data ? (
                    <article className="px-5 py-6 md:px-9 md:py-8">
                      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
                        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-2">
                          {mobile ? (
                            <Button
                              variant="ghost"
                              className="mb-2 self-start"
                              onPress={() => setSelectedId(null)}
                            >
                              <ArrowLeft aria-hidden /> Back to rubbish bin
                            </Button>
                          ) : null}
                          <Eyebrow>Retained page, read only</Eyebrow>
                          <h2 className="m-0 break-words font-serif text-[30px] font-normal leading-[1.1] md:text-[38px]">
                            {detailQuery.data.item.title}
                          </h2>
                        </div>
                        <div className="flex shrink-0 flex-wrap items-center gap-2 md:pt-[30px]">
                          <Button
                            variant="primary"
                            className="h-10 pr-5 pl-4"
                            isDisabled={lifecycleBusy}
                            onPress={() => {
                              if (!lifecycleBusy) void restoreSelected();
                            }}
                          >
                            <RotateCcw aria-hidden className="h-4 w-4" />{" "}
                            Restore
                          </Button>
                          <Button
                            variant="ghost"
                            className={QUIET_DANGER}
                            isDisabled={lifecycleBusy}
                            onPress={() => {
                              if (!lifecycleBusy) {
                                setConfirmation({
                                  kind: "purge",
                                  item: detailQuery.data.item,
                                });
                              }
                            }}
                          >
                            Delete permanently…
                          </Button>
                        </div>
                      </div>
                      <DetailMetadata item={detailQuery.data.item} />
                      <section
                        aria-labelledby="stored-preview-heading"
                        className="mt-9 flex flex-col gap-4"
                      >
                        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                          <Eyebrow
                            as="h3"
                            tick="live"
                            id="stored-preview-heading"
                          >
                            Stored body
                          </Eyebrow>
                          <span className="flex-1" />
                          {detailQuery.data.preview.truncated ? (
                            <span className="text-[12.5px] text-hot">
                              Preview is truncated
                            </span>
                          ) : null}
                        </div>
                        <section
                          aria-label="Read-only stored body preview"
                          className={cn(
                            "max-h-96 overflow-y-auto rounded-xl bg-ground px-5 py-4 md:ml-[17px] md:px-7 md:py-[22px]",
                            FOCUS_RING_NATIVE,
                          )}
                        >
                          {detailQuery.data.preview.encrypted ? (
                            <p className="text-[13.5px] text-mute">
                              This retained body is encrypted and is not
                              disclosed in the preview.
                            </p>
                          ) : (
                            <PreviewMarkdown
                              content={detailQuery.data.preview.body}
                            />
                          )}
                        </section>
                      </section>
                    </article>
                  ) : null}
                </section>
              ) : null}
            </div>
          )}
        </>
      )}

      <Dialog
        isOpen={confirmation !== null}
        isDismissable={!confirmationBusy}
        isCloseDisabled={confirmationBusy}
        onOpenChange={(open) => {
          if (!open && !confirmationBusy) setConfirmation(null);
        }}
        title={
          confirmation?.kind === "purge"
            ? "Delete permanently"
            : "Empty rubbish bin"
        }
        description={
          confirmation?.kind === "purge"
            ? `Delete “${confirmation.item.title}” and its retained content permanently? This cannot be undone.`
            : confirmation?.kind === "empty"
              ? `Permanently delete every valid item currently in the rubbish bin (${validItems.length} ${validItems.length === 1 ? "item" : "items"})? Every item will be attempted and this cannot be undone.`
              : undefined
        }
        footer={
          <>
            <Button
              variant="secondary"
              className="h-10 px-5"
              isDisabled={confirmationBusy}
              onPress={() => {
                if (!confirmationBusy) setConfirmation(null);
              }}
            >
              Cancel
            </Button>
            {confirmation?.kind === "purge" ? (
              <Button
                variant="danger"
                className="h-10 px-5"
                isDisabled={confirmationBusy}
                onPress={() => void confirmPurge(confirmation.item)}
              >
                {purge.isPending
                  ? "Deleting permanently…"
                  : "Delete permanently"}
              </Button>
            ) : confirmation?.kind === "empty" ? (
              <Button
                variant="danger"
                className="h-10 px-5"
                isDisabled={confirmationBusy}
                onPress={() => void confirmEmpty()}
              >
                {empty.isPending
                  ? "Emptying rubbish bin…"
                  : "Empty rubbish bin permanently"}
              </Button>
            ) : null}
          </>
        }
      >
        <p className="text-[14px] leading-relaxed text-ink-2">
          {confirmation?.kind === "purge"
            ? "The archived body, metadata, and retained attachments for this page will be removed."
            : "Successful deletions disappear immediately. Any failures remain in the bin and are reported in their original order."}
        </p>
        {confirmationBusy ? (
          <p
            role="status"
            aria-live="polite"
            className="mt-3 text-[13px] text-mute"
          >
            {confirmation?.kind === "purge"
              ? "Deleting permanently…"
              : `Deleting ${validItems.length} retained ${validItems.length === 1 ? "item" : "items"}…`}
          </p>
        ) : null}
      </Dialog>
    </main>
  );
}

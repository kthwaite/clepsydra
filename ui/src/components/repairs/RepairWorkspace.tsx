import { useEffect, useRef, useState } from "react";
import type { ReferenceIssueFilters } from "#/api/index";
import { Button } from "#/components/ui/button";
import { useReferenceIssues } from "#/api/index";
import { Dialog } from "#/components/ui/dialog";
import { useMobileLayout } from "#/hooks/useMobileLayout";
import { RepairFilters } from "./RepairFilters";
import { RepairIssueDetail } from "./RepairIssueDetail";
import { RepairIssueList } from "./RepairIssueList";

export interface RepairWorkspaceProps {
  target?: string;
  filters?: ReferenceIssueFilters;
  onFiltersChange?: (filters: ReferenceIssueFilters) => void;
}

export function RepairWorkspace({
  target,
  filters: controlledFilters,
  onFiltersChange,
}: RepairWorkspaceProps) {
  const [localFilters, setLocalFilters] = useState<ReferenceIssueFilters>(
    controlledFilters ?? {},
  );
  const filters = controlledFilters ?? localFilters;
  const queryFilters: ReferenceIssueFilters = {
    ...filters,
    limit: filters.limit ?? 100,
    offset: filters.offset ?? 0,
  };
  const issuesQuery = useReferenceIssues(queryFilters);
  const issues = issuesQuery.data?.items ?? [];
  const [selectedFingerprint, setSelectedFingerprint] = useState<string | null>(
    null,
  );
  const isMobile = useMobileLayout();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!issuesQuery.data) return;
    if (
      selectedFingerprint &&
      !issues.some((issue) => issue.fingerprint === selectedFingerprint)
    ) {
      setSelectedFingerprint(null);
    }
  }, [issues, issuesQuery.data, selectedFingerprint]);

  useEffect(() => {
    if (!issuesQuery.data) return;
    const offset = queryFilters.offset ?? 0;
    if (offset === 0) return;
    const limit = queryFilters.limit ?? 100;
    const lastOffset =
      issuesQuery.data.total === 0
        ? 0
        : Math.floor((issuesQuery.data.total - 1) / limit) * limit;
    if (offset <= lastOffset) return;
    const next = { ...filters, limit, offset: lastOffset };
    if (!controlledFilters) setLocalFilters(next);
    onFiltersChange?.(next);
  }, [
    controlledFilters,
    filters,
    issuesQuery.data,
    onFiltersChange,
    queryFilters.limit,
    queryFilters.offset,
  ]);

  const selectedIssue = selectedFingerprint
    ? (issues.find((issue) => issue.fingerprint === selectedFingerprint) ?? null)
    : null;

  function changeFilters(next: ReferenceIssueFilters) {
    const reset: ReferenceIssueFilters = {
      ...next,
      limit: filters.limit ?? 100,
      offset: 0,
    };
    if (!controlledFilters) setLocalFilters(reset);
    onFiltersChange?.(reset);
  }

  function changePage(offset: number) {
    const next = {
      ...filters,
      limit: filters.limit ?? 100,
      offset,
    };
    if (!controlledFilters) setLocalFilters(next);
    onFiltersChange?.(next);
  }

  function restoreRowFocus(fingerprint = selectedFingerprint) {
    if (!fingerprint) return;
    requestAnimationFrame(() => {
      rowRefs.current.get(fingerprint)?.focus();
    });
  }

  function closeMobileDetail() {
    const fingerprint = selectedFingerprint;
    setSelectedFingerprint(null);
    if (!fingerprint) return;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        rowRefs.current.get(fingerprint)?.focus();
      });
    });
  }

  return (
    <main className="mx-auto flex h-full min-h-screen w-full max-w-[1440px] flex-col bg-paper text-ink">
      <header className="border-b border-rule bg-paper-2 px-3 py-4 md:px-5">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <p className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
              Vault index / evidence-led repair
            </p>
            <h1 className="mt-1 text-2xl font-black tracking-tight">
              Reference repair
            </h1>
          </div>
          <p className="cl-mono text-[10px] tabular-nums text-ink-mute">
            {issuesQuery.data?.total ?? 0} issues
          </p>
        </div>
        {target ? (
          <p
            role="status"
            className="mt-3 border-l-2 border-cool bg-paper px-3 py-2 text-sm text-ink-2"
          >
            Opened from unresolved target: <code>{target}</code>. Review the
            matching evidence before repairing it.
          </p>
        ) : null}
      </header>

      <RepairFilters filters={filters} onChange={changeFilters} />

      {issuesQuery.isPending ? (
        <div
          role="status"
          className="cl-mono flex flex-1 items-center justify-center p-8 text-[11px] uppercase tracking-[0.18em] text-ink-mute"
        >
          Loading reference issues…
        </div>
      ) : issuesQuery.isError ? (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center p-8 text-sm text-hot"
        >
          Reference issues could not load. {issuesQuery.error?.message}
        </div>
      ) : issues.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <div>
            <p className="text-sm font-semibold">No reference issues match.</p>
            <p className="mt-1 text-xs text-ink-mute">
              Clear filters to inspect the complete repair ledger.
            </p>
            {(queryFilters.offset ?? 0) > 0 ? (
              <Button
                className="mt-3"
                size="sm"
                variant="ghost"
                onPress={() =>
                  changePage(
                    Math.max(
                      0,
                      (queryFilters.offset ?? 0) - (queryFilters.limit ?? 100),
                    ),
                  )
                }
              >
                Previous page
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(18rem,0.82fr)_minmax(24rem,1.18fr)]">
          <section
            aria-label="Issue ledger"
            className="flex min-h-0 flex-col border-r-0 border-rule md:border-r"
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              <RepairIssueList
                issues={issues}
                selectedFingerprint={selectedFingerprint}
                onSelect={setSelectedFingerprint}
                rowRefs={rowRefs}
                detailRef={detailRef}
              />
            </div>
            <nav
              aria-label="Issue pages"
              className="flex items-center justify-between gap-2 border-t border-rule bg-paper-2 px-3 py-2"
            >
              <Button
                size="sm"
                variant="ghost"
                aria-label="Previous page"
                isDisabled={(queryFilters.offset ?? 0) === 0}
                onPress={() =>
                  changePage(
                    Math.max(
                      0,
                      (queryFilters.offset ?? 0) - (queryFilters.limit ?? 100),
                    ),
                  )
                }
              >
                Previous
              </Button>
              <span className="cl-mono text-[10px] tabular-nums text-ink-mute">
                {(queryFilters.offset ?? 0) + 1}–
                {Math.min(
                  (queryFilters.offset ?? 0) + (queryFilters.limit ?? 100),
                  issuesQuery.data?.total ?? 0,
                )}{" "}
                of {issuesQuery.data?.total ?? 0}
              </span>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Next page"
                isDisabled={
                  (queryFilters.offset ?? 0) + (queryFilters.limit ?? 100) >=
                  (issuesQuery.data?.total ?? 0)
                }
                onPress={() =>
                  changePage(
                    (queryFilters.offset ?? 0) + (queryFilters.limit ?? 100),
                  )
                }
              >
                Next
              </Button>
            </nav>
          </section>

          {!isMobile ? (
            <section
              ref={detailRef}
              aria-label="Repair detail"
              role="region"
              tabIndex={-1}
              className="min-h-0 overflow-y-auto p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent lg:p-5"
            >
              {selectedIssue ? (
                <RepairIssueDetail
                  issue={selectedIssue}
                  onRefresh={() => issuesQuery.refetch()}
                  onApplied={restoreRowFocus}
                />
              ) : (
                <div className="flex h-full min-h-48 items-center justify-center text-center">
                  <div>
                    <p className="text-sm font-semibold">Select an issue</p>
                    <p className="mt-1 max-w-sm text-xs text-ink-mute">
                      Inspect source evidence, prepare a preview, then apply the
                      exact repair.
                    </p>
                  </div>
                </div>
              )}
            </section>
          ) : null}
        </div>
      )}

      {isMobile ? (
        <Dialog
          isOpen={selectedIssue !== null}
          onOpenChange={(isOpen) => {
            if (!isOpen) closeMobileDetail();
          }}
          title="Repair issue"
          description="Inspect evidence and preview the exact change before applying it."
          size="full"
          className="h-[calc(100dvh-2rem)]"
        >
          {selectedIssue ? (
            <RepairIssueDetail
              issue={selectedIssue}
              onRefresh={() => issuesQuery.refetch()}
              onApplied={closeMobileDetail}
            />
          ) : null}
        </Dialog>
      ) : null}
    </main>
  );
}

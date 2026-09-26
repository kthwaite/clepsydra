import { useEffect, useRef, useState } from "react";
import type { ReferenceIssueFilters } from "#/api/index";
import { useReferenceIssues } from "#/api/index";
import { Tick } from "#/components/codex/Tick";
import { Button } from "#/components/ui/button";
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
  const emptyResultsRef = useRef<HTMLDivElement>(null);
  const pendingAppliedFocusRef = useRef<{
    fingerprint: string;
    dataAtApply: typeof issuesQuery.data;
    refreshSettled: boolean;
    expectedSelection: string | null;
  } | null>(null);

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
    const pending = pendingAppliedFocusRef.current;
    if (!pending || !issuesQuery.data) return;
    if (!pending.refreshSettled || issuesQuery.data === pending.dataAtApply)
      return;
    if (selectedFingerprint !== pending.expectedSelection) {
      pendingAppliedFocusRef.current = null;
      return;
    }
    pendingAppliedFocusRef.current = null;
    requestAnimationFrame(() => {
      const appliedRow = rowRefs.current.get(pending.fingerprint);
      const firstIssue = issues[0];
      const target =
        (appliedRow?.isConnected ? appliedRow : null) ??
        (firstIssue
          ? rowRefs.current.get(firstIssue.fingerprint)
          : emptyResultsRef.current);
      target?.focus();
    });
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
    ? (issues.find((issue) => issue.fingerprint === selectedFingerprint) ??
      null)
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

  function coordinateAppliedFocus(
    fingerprint = selectedFingerprint,
    expectedSelection = selectedFingerprint,
  ) {
    if (!fingerprint) return;
    pendingAppliedFocusRef.current = {
      fingerprint,
      dataAtApply: issuesQuery.data,
      refreshSettled: false,
      expectedSelection,
    };
    void issuesQuery.refetch().finally(() => {
      const pending = pendingAppliedFocusRef.current;
      if (pending?.fingerprint !== fingerprint) return;
      pending.refreshSettled = true;
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

  function closeMobileAfterApply() {
    coordinateAppliedFocus(selectedFingerprint, null);
    setSelectedFingerprint(null);
  }

  const total = issuesQuery.data?.total ?? 0;

  return (
    <main className="mx-auto flex h-full min-h-screen w-full max-w-[1440px] flex-col bg-ground text-ink">
      <header className="px-4 pt-7 md:px-10">
        <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
          <div className="flex flex-col gap-2.5">
            <p className="flex items-center gap-2.5">
              <Tick />
              <span className="font-serif text-[19px] italic leading-none text-mute">
                Vault index
              </span>
            </p>
            <h1 className="font-serif text-[44px] leading-none tracking-[-0.015em] text-ink md:text-[56px]">
              Reference repair
            </h1>
          </div>
          <p className="pb-1.5 text-[14px] tabular-nums text-mute">
            {total} {total === 1 ? "issue" : "issues"} · inspect the evidence,
            preview, then apply
          </p>
        </div>
        {target ? (
          <p
            role="status"
            className="mt-4 rounded-xl bg-accent-tint px-4 py-2.5 text-[14px] text-ink-2"
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
          className="flex flex-1 items-center justify-center p-8 text-[13.5px] text-mute"
        >
          Loading reference issues…
        </div>
      ) : issuesQuery.isError ? (
        <div
          role="alert"
          className="flex flex-1 items-center justify-center p-8 text-[14px] text-hot"
        >
          Reference issues could not load. {issuesQuery.error?.message}
        </div>
      ) : issues.length === 0 ? (
        <div
          ref={emptyResultsRef}
          role="status"
          aria-label="Reference repair results"
          tabIndex={-1}
          className="flex flex-1 items-center justify-center p-8 text-center outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
        >
          <div>
            <p className="font-serif text-[22px] text-ink">
              No reference issues match.
            </p>
            <p className="mt-1.5 text-[13.5px] text-mute">
              Clear filters to inspect the complete repair ledger.
            </p>
            {(queryFilters.offset ?? 0) > 0 ? (
              <Button
                className="mt-3"
                size="sm"
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
        <div className="grid min-h-0 flex-1 gap-6 px-4 pt-5 pb-6 md:grid-cols-[minmax(16rem,0.8fr)_minmax(0,1.2fr)] md:px-10 xl:grid-cols-[440px_minmax(0,1fr)] xl:gap-10">
          <section
            aria-label="Issue ledger"
            className="-mx-3.5 flex min-h-0 min-w-0 flex-col"
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
              className="flex items-center gap-2 px-3.5 pt-3 text-[13px] text-mute"
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
              <span className="flex-1 text-center tabular-nums">
                {(queryFilters.offset ?? 0) + 1}–
                {Math.min(
                  (queryFilters.offset ?? 0) + (queryFilters.limit ?? 100),
                  issuesQuery.data?.total ?? 0,
                )}{" "}
                of {issuesQuery.data?.total ?? 0}
              </span>
              <Button
                size="sm"
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
              tabIndex={-1}
              className="min-h-0 min-w-0 overflow-y-auto rounded-2xl bg-raise px-6 py-6 outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-ground xl:px-8"
            >
              {selectedIssue ? (
                <RepairIssueDetail
                  key={selectedIssue.fingerprint}
                  issue={selectedIssue}
                  onRefresh={() => issuesQuery.refetch()}
                  onApplied={coordinateAppliedFocus}
                />
              ) : (
                <div className="flex h-full min-h-48 items-center justify-center text-center">
                  <div>
                    <p className="font-serif text-[22px] text-ink">
                      Select an issue
                    </p>
                    <p className="mt-1.5 max-w-sm text-[13.5px] text-mute">
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
              key={selectedIssue.fingerprint}
              issue={selectedIssue}
              onRefresh={() => issuesQuery.refetch()}
              onApplied={closeMobileAfterApply}
            />
          ) : null}
        </Dialog>
      ) : null}
    </main>
  );
}

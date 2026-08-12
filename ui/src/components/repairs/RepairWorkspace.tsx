import { useEffect, useRef, useState } from "react";
import type { ReferenceIssueFilters } from "#/api/index";
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
  const issuesQuery = useReferenceIssues(filters);
  const issues = issuesQuery.data?.items ?? [];
  const [selectedFingerprint, setSelectedFingerprint] = useState<string | null>(
    null,
  );
  const isMobile = useMobileLayout();
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const detailRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (
      selectedFingerprint &&
      !issues.some((issue) => issue.fingerprint === selectedFingerprint)
    ) {
      setSelectedFingerprint(null);
    }
  }, [issues, selectedFingerprint]);

  const selectedIssue = selectedFingerprint
    ? (issues.find((issue) => issue.fingerprint === selectedFingerprint) ?? null)
    : null;

  function changeFilters(next: ReferenceIssueFilters) {
    if (!controlledFilters) setLocalFilters(next);
    onFiltersChange?.(next);
  }

  function restoreRowFocus() {
    if (!selectedFingerprint) return;
    requestAnimationFrame(() => {
      rowRefs.current.get(selectedFingerprint)?.focus();
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
          </div>
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 md:grid-cols-[minmax(18rem,0.82fr)_minmax(24rem,1.18fr)]">
          <section
            aria-label="Issue ledger"
            className="min-h-0 overflow-y-auto border-r-0 border-rule md:border-r"
          >
            <RepairIssueList
              issues={issues}
              selectedFingerprint={selectedFingerprint}
              onSelect={setSelectedFingerprint}
              rowRefs={rowRefs}
              detailRef={detailRef}
            />
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
            if (!isOpen) {
              restoreRowFocus();
              setSelectedFingerprint(null);
            }
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
              onApplied={restoreRowFocus}
            />
          ) : null}
        </Dialog>
      ) : null}
    </main>
  );
}

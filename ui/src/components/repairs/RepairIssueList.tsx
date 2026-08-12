import type { RefObject } from "react";
import type { ReferenceIssue } from "#/api/index";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";

const KIND_LABELS: Record<ReferenceIssue["kind"], string> = {
  unresolved_page_link: "Unresolved link",
  ambiguous_page_link: "Ambiguous link",
  broken_block_ref: "Broken block",
  invalid_relation_target: "Invalid relation",
  orphan_page: "Orphan page",
  isolated_page: "Isolated page",
};

export function issueLabel(issue: ReferenceIssue): string {
  return (
    issue.target_raw ||
    issue.source_title ||
    issue.source_path ||
    KIND_LABELS[issue.kind]
  );
}

export interface RepairIssueListProps {
  issues: ReferenceIssue[];
  selectedFingerprint: string | null;
  onSelect: (fingerprint: string) => void;
  rowRefs: RefObject<Map<string, HTMLButtonElement>>;
  detailRef: RefObject<HTMLElement | null>;
}

export function RepairIssueList({
  issues,
  selectedFingerprint,
  onSelect,
  rowRefs,
  detailRef,
}: RepairIssueListProps) {
  function handleKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      const focused = issues[index];
      if (focused) onSelect(focused.fingerprint);
      detailRef.current?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = Math.min(
      Math.max(index + direction, 0),
      issues.length - 1,
    );
    const next = issues[nextIndex];
    if (!next) return;
    onSelect(next.fingerprint);
    rowRefs.current.get(next.fingerprint)?.focus();
  }

  return (
    <ul aria-label="Reference issues" className="divide-y divide-rule">
      {issues.map((issue, index) => {
        const isSelected = selectedFingerprint === issue.fingerprint;
        const actionable = issue.actions.some(
          (action) => action === "replace" || action === "create",
        );
        return (
          <li key={issue.fingerprint}>
            <Button
              variant="ghost"
              aria-current={isSelected ? "true" : undefined}
              onPress={() => onSelect(issue.fingerprint)}
              onKeyDown={(event) => handleKeyDown(event, index)}
              className={cn(
                "h-auto w-full justify-start border-0 border-l-2 px-3 py-3 text-left normal-case tracking-normal",
                isSelected
                  ? "border-l-accent bg-highlight text-ink"
                  : "border-l-transparent text-ink hover:bg-paper-edge",
              )}
            >
              <span
                ref={(node) => {
                  const button = node?.closest("button");
                  if (button) rowRefs.current.set(issue.fingerprint, button);
                  else rowRefs.current.delete(issue.fingerprint);
                }}
                className="min-w-0 flex-1"
              >
                <span className="flex items-center justify-between gap-3">
                  <span className="truncate text-sm font-semibold">
                    {issueLabel(issue)}
                  </span>
                  <span
                    className={cn(
                      "cl-mono shrink-0 text-[9px] uppercase tracking-[0.14em]",
                      actionable ? "text-cool" : "text-ink-mute",
                    )}
                  >
                    {actionable ? "Repair" : "Inspect"}
                  </span>
                </span>
                <span className="mt-1 flex min-w-0 items-center gap-2 text-[10px] text-ink-mute">
                  <span className="cl-mono shrink-0 uppercase tracking-[0.12em]">
                    {KIND_LABELS[issue.kind]}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="truncate">{issue.source_path}</span>
                </span>
              </span>
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

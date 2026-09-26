import type { RefObject } from "react";
import type { ReferenceIssue } from "#/api/index";
import { Button } from "#/components/ui/button";
import { cn } from "#/lib/cn";

export const KIND_LABELS: Record<ReferenceIssue["kind"], string> = {
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
    <ul aria-label="Reference issues" className="flex flex-col gap-0.5">
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
                "h-auto w-full justify-start rounded-xl px-3.5 py-2.5 text-left font-normal",
                isSelected
                  ? "bg-accent-tint text-ink data-[hovered]:bg-accent-tint"
                  : "text-ink data-[hovered]:text-ink",
              )}
            >
              <span
                ref={(node) => {
                  const button = node?.closest("button");
                  if (button) rowRefs.current.set(issue.fingerprint, button);
                  else rowRefs.current.delete(issue.fingerprint);
                }}
                className="flex min-w-0 flex-1 flex-col gap-1"
              >
                <span className="flex min-w-0 items-baseline gap-3">
                  <span className="min-w-0 flex-1 truncate text-[14.5px] font-medium text-ink">
                    {issueLabel(issue)}
                  </span>
                  <span
                    className={cn(
                      "shrink-0 text-[12.5px]",
                      actionable ? "text-accent" : "text-mute",
                    )}
                  >
                    {actionable ? "Repair" : "Inspect"}
                  </span>
                </span>
                <span className="flex min-w-0 items-baseline gap-2 text-[12.5px] text-mute">
                  <span className="shrink-0 text-ink-2">
                    {KIND_LABELS[issue.kind]}
                  </span>
                  <span aria-hidden="true" className="text-faint">
                    ·
                  </span>
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

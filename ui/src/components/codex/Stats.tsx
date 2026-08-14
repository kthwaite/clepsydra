import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import {
  useContentIndex,
  useReferenceIssues,
  useStats,
  useTags,
} from "#/api/index";
import { cn } from "#/lib/cn";
import { deriveInventory } from "./atrium-data";
import { Card } from "./Card";

const REFERENCE_ISSUE_COUNT_FILTERS = { limit: 1, offset: 0 };

export function Stats() {
  const navigate = useNavigate();
  const { data: tags } = useTags();
  const { data: stats } = useStats();
  const { data: content } = useContentIndex({ limit: 500 });
  const { data: referenceIssues } = useReferenceIssues(
    REFERENCE_ISSUE_COUNT_FILTERS,
  );

  const items = content?.items ?? [];
  const inventory = useMemo(
    () => deriveInventory(stats, tags, items),
    [stats, tags, items],
  );
  const topTags = useMemo(
    () => [...(tags ?? [])].sort((a, b) => b.count - a.count).slice(0, 8),
    [tags],
  );
  const maxTag = topTags[0]?.count ?? 1;

  return (
    <div className="mx-auto grid max-w-[1600px] auto-rows-min grid-cols-12 gap-3.5 px-2 py-2 md:px-4 md:py-4">
      <Card
        className="col-span-12"
        label="Vessel · Inventory"
        caption="FIG. I — STEADY-STATE TELEMETRY"
        action={
          <button
            type="button"
            onClick={() => navigate({ to: "/repairs" })}
            aria-label={
              referenceIssues
                ? `Open Reference Repairs, ${referenceIssues.total.toLocaleString("en-US")} issues`
                : "Open Reference Repairs"
            }
            className="cl-mono border-l border-rule pl-2.5 text-[9px] uppercase tracking-[0.18em] text-ink-mute hover:text-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          >
            {referenceIssues
              ? `${referenceIssues.total.toLocaleString("en-US")} issues`
              : "Repairs"}{" "}
            →
          </button>
        }
        tight
      >
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8">
          {inventory.map((cell, i) => (
            <div
              key={cell.label}
              className={cn(
                "flex flex-col gap-1 border-rule px-2.5 py-3 md:px-3.5",
                i % 2 === 0 ? "border-r" : "border-r-0",
                i >= 2 ? "border-t" : "border-t-0",
                i % 4 !== 3 ? "md:border-r" : "md:border-r-0",
                i >= 4 ? "md:border-t" : "md:border-t-0",
                i !== 7 ? "lg:border-r" : "lg:border-r-0",
                "lg:border-t-0",
              )}
            >
              <span className="cl-mono text-[9px] uppercase tracking-[0.22em] text-ink-mute">
                {cell.label}
              </span>
              <span
                className={cn(
                  "font-sans text-[28px] font-bold leading-none tabular-nums",
                  cell.tone === "warn" ? "text-warn" : "text-ink",
                )}
              >
                {cell.value}
              </span>
              {cell.sub ? (
                <span className="cl-mono text-[9px] tracking-[0.12em] text-ink-mute">
                  {cell.sub}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Card>

      <Card
        className="col-span-12 [&>div:last-child]:p-2.5 md:[&>div:last-child]:p-3.5 lg:col-span-4"
        label="Subjects, by frequency"
        caption="FIG. V"
      >
        {topTags.length === 0 ? (
          <p className="cl-marg m-0">No tags yet.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {topTags.map((tag) => (
              <button
                type="button"
                key={tag.tag}
                onClick={() =>
                  navigate({
                    to: "/gazetteer",
                    search: { tags: [tag.tag] },
                  })
                }
                className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_minmax(60px,1fr)_32px] items-center gap-2 text-left md:grid-cols-[120px_1fr_36px]"
              >
                <span className="cl-mono overflow-hidden text-ellipsis whitespace-nowrap text-[11px] text-ink-2 group-hover:text-accent">
                  #{tag.tag}
                </span>
                <span className="h-[8px] bg-rule-soft">
                  <span
                    className="block h-full bg-accent"
                    style={{
                      width: `${Math.max(4, (tag.count / maxTag) * 100)}%`,
                    }}
                  />
                </span>
                <span className="cl-mono text-right text-[10px] tabular-nums text-ink-mute">
                  {tag.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

import { useNavigate } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";
import {
  useContentIndex,
  useReferenceIssues,
  useStats,
  useTags,
} from "#/api/index";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { formatRelativeTime } from "#/lib/time";
import { deriveInventory } from "./atrium-data";
import { Section } from "./Section";
import { Tick } from "./Tick";

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

  const tagTotal = tags?.length ?? 0;
  const tagCaption =
    topTags.length === tagTotal
      ? `All ${tagTotal} ${tagTotal === 1 ? "tag" : "tags"}`
      : `Top ${topTags.length} of ${tagTotal.toLocaleString("en-US")} tags`;
  const lastIndexedAt = stats?.last_indexed_at;

  return (
    <div className="mx-auto flex max-w-[1600px] flex-col gap-11 px-4 pt-7 pb-10 md:px-10 md:pt-8">
      <div className="flex flex-wrap items-end gap-x-7 gap-y-3">
        <div className="flex flex-col gap-2.5">
          <span className="flex items-center gap-2.5">
            <Tick />
            <span className="font-serif text-[19px] italic text-mute">
              Vault
            </span>
          </span>
          <h1 className="font-serif text-[44px] leading-none tracking-[-0.015em] text-ink md:text-[56px]">
            Stats
          </h1>
        </div>
        {lastIndexedAt ? (
          <span className="pb-1.5 text-[14px] text-mute">
            Counts from the index, last collated{" "}
            {formatRelativeTime(lastIndexedAt)}
          </span>
        ) : null}
      </div>

      <Section
        label="Inventory"
        wrapHeader
        action={
          <button
            type="button"
            onClick={() => navigate({ to: "/repairs" })}
            aria-label={
              referenceIssues
                ? `Open Reference Repairs, ${referenceIssues.total.toLocaleString("en-US")} issues`
                : "Open Reference Repairs"
            }
            className={cn(
              "flex h-9 items-center gap-2 rounded-full bg-sink px-4 text-[13.5px] text-ink hover:text-accent",
              FOCUS_RING_NATIVE,
            )}
          >
            {referenceIssues && referenceIssues.total > 0 ? (
              <span
                aria-hidden
                className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-hot"
              />
            ) : null}
            {referenceIssues
              ? `${referenceIssues.total.toLocaleString("en-US")} reference issues`
              : "Repairs"}
            <ArrowRight aria-hidden className="h-[13px] w-[13px]" />
          </button>
        }
      >
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
          {inventory.map((cell) => (
            <div
              key={cell.label}
              className="flex min-w-0 flex-col gap-1 rounded-2xl bg-raise px-[18px] py-3.5"
            >
              <span className="truncate text-[13px] text-mute">
                {cell.label}
              </span>
              <span
                className={cn(
                  "font-serif text-[40px] leading-none tabular-nums md:text-[46px]",
                  cell.tone === "warn" ? "text-hot" : "text-ink",
                )}
              >
                {cell.value}
              </span>
              {cell.sub ? (
                <span className="truncate text-[12.5px] text-mute">
                  {cell.sub}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </Section>

      <Section
        label="Subjects, by frequency"
        caption={topTags.length > 0 ? tagCaption : undefined}
        wrapHeader
      >
        {topTags.length === 0 ? (
          <p className="m-0 text-[14px] text-mute">No tags yet.</p>
        ) : (
          <div className="flex max-w-[720px] flex-col gap-0.5">
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
                className={cn(
                  "group grid min-h-[30px] cursor-pointer grid-cols-[minmax(0,1fr)_minmax(60px,1fr)_40px] items-center gap-4 rounded-md text-left text-[14px] text-ink-2 md:grid-cols-[180px_minmax(0,1fr)_48px]",
                  FOCUS_RING_NATIVE,
                )}
              >
                <span className="truncate group-hover:text-accent">
                  <span className="text-faint">#</span>
                  {tag.tag}
                </span>
                <span className="block h-1.5 overflow-hidden rounded-full bg-sink">
                  <span
                    className="block h-full rounded-full bg-accent"
                    style={{
                      width: `${Math.max(4, (tag.count / maxTag) * 100)}%`,
                    }}
                  />
                </span>
                <span className="text-right text-[13px] tabular-nums text-mute">
                  {tag.count}
                </span>
              </button>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

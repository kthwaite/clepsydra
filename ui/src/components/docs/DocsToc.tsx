import type { RefObject } from "react";
import { Tick } from "#/components/codex/Tick";
import {
  type ScrollSpyOptions,
  useScrollSpy,
} from "#/components/codex/useScrollSpy";
import type { DocTocEntry } from "#/docs/toc";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";

// the h1 page title lives in DocsArticle's header, outside the compiled MDX,
// so it is excluded here to keep DOM order aligned with extractDocToc
const DOCS_SCROLL_SPY: ScrollSpyOptions = {
  rootSelector: "article",
  headingSelector: "h2,h3,h4,h5,h6",
};

export interface DocsTocProps {
  entries: readonly DocTocEntry[];
  /** the scrolling article container the entries jump within */
  containerRef: RefObject<HTMLElement | null>;
  /** changing value that re-runs heading discovery — the active guide slug */
  recount?: unknown;
  /** invoked after a choice, so a host drawer can dismiss itself */
  onNavigate?: () => void;
  className?: string;
}

export function DocsToc({
  entries,
  containerRef,
  recount,
  onNavigate,
  className,
}: DocsTocProps) {
  const { activeIndex, scrollTo } = useScrollSpy(
    containerRef,
    recount,
    undefined,
    DOCS_SCROLL_SPY,
  );

  if (entries.length === 0) {
    return null;
  }

  return (
    <nav
      aria-label="On this page"
      className={cn("flex min-h-0 flex-col gap-3", className)}
    >
      <div className="flex shrink-0 items-center gap-2.5">
        <Tick />
        <h2 className="font-serif text-[18px] font-normal italic leading-none text-mute">
          On this page
        </h2>
      </div>
      <ul className="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pl-[5px]">
        {entries.map((entry, index) => {
          const active = index === activeIndex;

          return (
            // slugger disambiguation makes ids unique within a document
            <li key={entry.id}>
              <button
                type="button"
                aria-current={active ? "location" : undefined}
                onClick={() => {
                  scrollTo(index);
                  onNavigate?.();
                }}
                style={{ paddingLeft: (entry.depth - 2) * 14 + 12 }}
                className={cn(
                  "block w-full cursor-pointer truncate rounded-[10px] py-1.5 pr-2.5 text-left text-[13px] leading-5 transition-colors",
                  FOCUS_RING_NATIVE,
                  active
                    ? "bg-accent-tint text-ink"
                    : "text-mute hover:text-ink",
                )}
              >
                {entry.text}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

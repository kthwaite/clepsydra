import type { RefObject } from "react";
import {
  type ScrollSpyOptions,
  useScrollSpy,
} from "#/components/codex/useScrollSpy";
import type { DocTocEntry } from "#/docs/toc";
import { cn } from "#/lib/cn";

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
      className={cn("flex min-h-0 flex-col bg-paper-2 font-mono", className)}
    >
      <h2 className="shrink-0 border-b border-rule px-3 py-2 text-xs font-semibold uppercase tracking-widest text-ink-mute">
        On this page
      </h2>
      <ul className="min-h-0 flex-1 overflow-y-auto py-2">
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
                style={{ paddingLeft: (entry.depth - 2) * 8 + 8 }}
                className={cn(
                  "block w-full cursor-pointer overflow-hidden text-ellipsis whitespace-nowrap border-l-2 py-1 pr-3 text-left text-[11px] leading-5 outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
                  active
                    ? "border-accent bg-highlight text-ink"
                    : "border-transparent text-ink-mute hover:text-ink",
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

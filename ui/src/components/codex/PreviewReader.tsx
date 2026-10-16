import { useEffect, useMemo, useRef, useState } from "react";
import { attachmentUrl, useAttachments } from "#/api/attachments";
import { stripFrontmatter } from "#/components/codex/folio-utils";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { findPreviewPassage } from "#/lib/previewPassage";
import type { PreviewTarget } from "#/lib/previewTarget";

/** Full saved content; no excerpt truncation or preview-specific Markdown dialect. */
export function PreviewReader({
  target,
  body,
  restricted,
  scrollRoot,
}: {
  target: PreviewTarget;
  body: string;
  restricted?: boolean;
  scrollRoot: React.RefObject<HTMLElement | null>;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const savedPassageScroll = useRef(0);
  const pendingNavigation = useRef<"page" | "passage" | null>(null);
  const [missing, setMissing] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const inventory = useAttachments();
  const attachmentPaths = useMemo(
    () =>
      new Map(
        (inventory.data ?? []).map((item) => [
          item.vault_path,
          attachmentUrl(item.path),
        ]),
      ),
    [inventory.data],
  );
  const heading = target.heading;
  const blockId = target.blockId;
  const addressed = !!(heading || blockId);

  useEffect(() => {
    const root = contentRef.current;
    const scroller = scrollRoot.current;
    if (!root || !scroller || !addressed) return;
    const passage = body
      ? findPreviewPassage(root, { heading, blockId })
      : null;
    setMissing(!passage);
    if (passage) {
      // Never scrollIntoView: that also scrolls ancestors/the originating page.
      scroller.scrollTop +=
        passage.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        (noticeRef.current?.getBoundingClientRect().height ?? 0);
    }
  }, [body, heading, blockId, addressed, scrollRoot]);

  useEffect(() => {
    const scroller = scrollRoot.current;
    if (!scroller || !pendingNavigation.current) return;
    scroller.scrollTop = showFull ? 0 : savedPassageScroll.current;
    pendingNavigation.current = null;
  }, [showFull, scrollRoot]);

  return (
    <div className="px-4 pb-5">
      {addressed ? (
        <div
          ref={noticeRef}
          data-preview-notice
          className="sticky top-0 z-10 mb-3 rounded-xl bg-sink p-3 text-sm text-ink-2"
        >
          <p>
            {showFull
              ? "Full page"
              : missing
                ? "The requested passage is missing from this page."
                : `Reading ${target.heading ? `section: ${target.heading}` : `block: ${target.blockId}`}`}
          </p>
          <button
            type="button"
            className={cn("mt-2 rounded-full text-accent", FOCUS_RING_NATIVE)}
            onClick={() => {
              if (showFull) {
                pendingNavigation.current = "passage";
                setShowFull(false);
              } else {
                savedPassageScroll.current = scrollRoot.current?.scrollTop ?? 0;
                pendingNavigation.current = "page";
                setShowFull(true);
              }
            }}
          >
            {showFull
              ? missing
                ? "Return to passage notice"
                : "Return to passage"
              : "Show full page"}
          </button>
        </div>
      ) : null}
      <div
        ref={contentRef}
        data-preview-content
        className="select-text break-words text-[15px] leading-relaxed text-ink-2"
      >
        <MarkdownRenderer
          content={stripFrontmatter(body)}
          pagePath={target.path}
          attachmentPaths={attachmentPaths}
          restricted={restricted}
        />
      </div>
    </div>
  );
}

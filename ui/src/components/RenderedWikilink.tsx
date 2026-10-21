import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useRef,
} from "react";
import { toast } from "sonner";
import {
  isModifiedLinkActivation,
  usePreviewTrigger,
} from "#/components/codex/usePreviewTrigger";
import {
  useResolveWikilinkTarget,
  wikilinkPageName,
} from "#/editor/useResolveWikilinkTarget";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  previewOpenTarget,
  previewTargetHref,
  wikilinkPreviewTarget,
} from "#/lib/previewTarget";
import type { OpenTabTarget } from "#/store/workspace";

interface RenderedWikilinkProps {
  /** Raw wikilink target, e.g. `Target` or `Target#Heading`. */
  target: string;
  children?: ReactNode;
  /** Opens the resolved page. */
  onOpen: (path: string, label: string, target?: OpenTabTarget) => void;
  /**
   * Style an unresolved link as dangling (mute, italic). Turn off where no
   * WikilinkResolutionProvider surrounds the link, so every lookup misses
   * and dangling styling would mislabel real pages.
   */
  markDangling?: boolean;
}

/**
 * A wikilink in rendered (read-only) Markdown. It first looks its target up
 * synchronously in the surrounding WikilinkResolutionProvider, as the editor's
 * WikilinkElement does. A miss renders dangling and resolves on click — but
 * resolve-only: derived output never creates a page, because a link naming a
 * page by path or file stem would otherwise create a duplicate. Without a
 * provider every lookup misses, and the click still resolves through search.
 */
export function RenderedWikilink({
  target,
  children,
  onOpen,
  markDangling = true,
}: RenderedWikilinkProps) {
  const { lookup } = useWikilinkResolution();
  const { resolve } = useResolveWikilinkTarget();
  // Guards against double-fire while resolution is in flight.
  const inFlightRef = useRef(false);
  const resolved = lookup(target);
  const label = wikilinkPageName(target) || target;

  const resolveTarget = async () => {
    try {
      const found = await resolve(target);
      if (found) return wikilinkPreviewTarget(found.path, target);
      toast.error(`No page named “${label}”`);
    } catch {
      toast.error(`Could not look up “${label}”`);
    }
    return null;
  };
  const previewTarget = resolved
    ? wikilinkPreviewTarget(resolved, target)
    : undefined;
  const preview = usePreviewTrigger(previewTarget, resolveTarget);

  const handleClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    if (resolved && isModifiedLinkActivation(event)) return;
    event.preventDefault();
    if (inFlightRef.current) return;
    if (preview.parentId && !isModifiedLinkActivation(event)) {
      await preview.openReader(event.currentTarget);
      return;
    }
    inFlightRef.current = true;
    try {
      const found = previewTarget ?? (await resolveTarget());
      if (found) {
        if (found.heading || found.blockId)
          onOpen(found.path, label, previewOpenTarget(found));
        else onOpen(found.path, label);
      }
    } finally {
      inFlightRef.current = false;
    }
  };

  const className = cn(
    "underline decoration-1 underline-offset-2 hover:decoration-2",
    FOCUS_RING_NATIVE,
    // Resolved links read as links; a missing page reads mute and italic,
    // as in the editor.
    resolved ? undefined : "cursor-pointer",
    !resolved && markDangling && "italic text-mute",
  );

  return (
    // biome-ignore lint/a11y/useSemanticElements: Inline references are phrasing content, not form fieldsets.
    <span
      role="group"
      aria-label="Page reference"
      className="inline"
      onMouseEnter={preview.onMouseEnter}
      onMouseLeave={preview.onMouseLeave}
      onFocus={preview.onFocus}
      onBlur={preview.onBlur}
    >
      <a
        {...{
          role: "link" as const,
          onClick: handleClick,
          onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => {
            if (!resolved && event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.click();
            }
          },
        }}
        ref={(element) => {
          preview.triggerRef.current = element;
        }}
        href={previewTarget ? previewTargetHref(previewTarget) : undefined}
        tabIndex={0}
        className={className}
        data-link-resource="wikilink"
      >
        {children}
      </a>
    </span>
  );
}

import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useRef,
} from "react";
import { toast } from "sonner";
import {
  useResolveWikilinkTarget,
  wikilinkPageName,
} from "#/editor/useResolveWikilinkTarget";
import { useWikilinkResolution } from "#/editor/wikilinkResolution";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { pageHref } from "#/lib/markdown/wikilinks";

interface RenderedWikilinkProps {
  /** Raw wikilink target, e.g. `Target` or `Target#Heading`. */
  target: string;
  children?: ReactNode;
  /** Opens the resolved page. */
  onOpen: (path: string, label: string) => void;
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

  const handleClick = async (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (resolved) {
      onOpen(resolved, label);
      return;
    }
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const found = await resolve(target);
      if (found) onOpen(found.path, label);
      else toast.error(`No page named “${label}”`);
    } catch {
      toast.error(`Could not look up “${label}”`);
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

  if (resolved) {
    return (
      <a
        href={pageHref(resolved)}
        onClick={handleClick}
        className={className}
        data-link-resource="wikilink"
      >
        {children}
      </a>
    );
  }

  // No href until the target resolves, so the anchor is focusable and
  // keyboard-activated by hand — the same shape as WikilinkElement's dangling
  // link, including its spread past biome's anchor rule.
  return (
    <a
      {...{
        role: "link" as const,
        onClick: handleClick,
        onKeyDown: (event: KeyboardEvent<HTMLAnchorElement>) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.click();
          }
        },
      }}
      tabIndex={0}
      className={className}
      data-link-resource="wikilink"
    >
      {children}
    </a>
  );
}

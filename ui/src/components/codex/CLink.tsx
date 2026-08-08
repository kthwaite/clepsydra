import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import {
  cancelHoverClose,
  scheduleHoverClose,
  usePreviewStore,
} from "#/store/preview";

const HOVER_DELAY = 220;

export type CLinkPayload = {
  title?: string;
  folio?: string;
  tags?: string[];
  excerpt?: string;
  words?: number;
  backlinks?: number;
};

type CLinkProps = {
  /** Vault path — when provided, page metadata is fetched lazily on hover. */
  path?: string;
  /** Static payload — for inline references that aren't backed by a real page. */
  payload?: CLinkPayload;
  children: ReactNode;
  /** Override click. Defaults to opening the page tab if `path` is set. */
  onClick?: (e: ReactMouseEvent) => void;
  /** Disable navigation entirely. */
  noNavigate?: boolean;
  className?: string;
  style?: CSSProperties;
};

export function CLink({
  path,
  payload,
  children,
  onClick,
  noNavigate,
  className,
  style,
}: CLinkProps) {
  const [hover, setHover] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);
  const delayRef = useRef<number | null>(null);
  const openTab = useOpenTab();
  const openHover = usePreviewStore((s) => s.openHover);
  const closePath = usePreviewStore((s) => s.closePath);

  // Path-backed links route through the window manager; payload-only links
  // (e.g. tag chips) keep the lightweight inline card.
  const note: CLinkPayload | null = payload ?? null;

  const enter = () => {
    if (path) {
      cancelHoverClose();
      delayRef.current = window.setTimeout(() => {
        const rect = ref.current?.getBoundingClientRect();
        if (rect) openHover(path, rect);
      }, HOVER_DELAY);
    } else {
      setHover(true);
    }
  };
  const leave = () => {
    if (path) {
      if (delayRef.current !== null) {
        window.clearTimeout(delayRef.current);
        delayRef.current = null;
      }
      scheduleHoverClose();
    } else {
      setHover(false);
    }
  };

  const handleClick = (e: ReactMouseEvent) => {
    if (onClick) {
      onClick(e);
      return;
    }
    if (path && !noNavigate) {
      closePath(path);
      openTab("page", path);
    }
  };

  return (
    <span
      ref={ref}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter") handleClick(e as unknown as ReactMouseEvent);
      }}
      role="link"
      tabIndex={0}
      className={cn("cl-link relative cursor-pointer", className)}
      style={style}
    >
      {children}
      {hover && note && (
        <span className="absolute left-0 top-full z-40 mt-[6px] block w-[320px] cursor-default border-[1.5px] border-ink bg-paper px-[10px] py-2 text-left text-[12px] not-italic leading-[1.4] text-ink shadow-[4px_4px_0_0_var(--color-ink)] font-body">
          <span className="mb-1 flex items-baseline justify-between border-b border-rule-soft pb-[3px]">
            <span className="cl-cap text-[9px] text-ink-mute">
              § {note.folio || "Folio"}
            </span>
            <span className="cl-mono text-[9px] text-ink-mute">
              {note.words ?? "—"} wd · ↗{note.backlinks ?? 0}
            </span>
          </span>
          <span className="mb-[3px] block font-serif text-[14px] font-semibold leading-[1.2]">
            {note.title}
          </span>
          {note.excerpt && (
            <span className="block font-body text-[11.5px] italic leading-[1.45] text-ink-mute">
              {note.excerpt.slice(0, 180)}
              {note.excerpt.length > 180 ? "…" : ""}
            </span>
          )}
          {note.tags && note.tags.length > 0 && (
            <span className="cl-mono mt-[5px] block border-t border-dotted border-rule-soft pt-1 text-[9px] text-accent-deep">
              {note.tags.map((t) => `#${t}`).join(" · ")}
            </span>
          )}
        </span>
      )}
    </span>
  );
}

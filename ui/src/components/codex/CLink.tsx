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

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

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
  /** Trailing resource mark (`[data-link-resource]` in main.css). */
  resource?: string;
};

export function CLink({
  path,
  payload,
  children,
  onClick,
  noNavigate,
  className,
  style,
  resource,
}: CLinkProps) {
  const [hover, setHover] = useState(false);
  const [above, setAbove] = useState(false);
  const ref = useRef<HTMLAnchorElement | null>(null);
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
      // Open the inline card above links in the lower half of the viewport.
      const rect = ref.current?.getBoundingClientRect();
      setAbove(!!rect && (rect.top + rect.bottom) / 2 > window.innerHeight / 2);
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
      e.preventDefault();
      return;
    }
    e.preventDefault();
    if (path && !noNavigate) {
      closePath(path);
      openTab("page", path);
    }
  };

  return (
    <a
      ref={ref}
      href={path ? `/pages/${path}` : "#"}
      onMouseEnter={enter}
      onMouseLeave={leave}
      onClick={handleClick}
      className={cn("cl-link relative cursor-pointer", className)}
      style={style}
      data-link-resource={resource}
    >
      {children}
      {hover && note && (
        <span
          className={cn(
            "absolute left-0 z-40 block",
            above ? "bottom-full mb-1.5" : "top-full mt-1.5",
            "w-[320px] cursor-default rounded-2xl bg-raise px-4 pt-3.5 pb-4 text-left not-italic text-ink shadow-lg",
          )}
        >
          <span className="flex items-baseline justify-between gap-3 text-[12.5px] text-mute">
            <span>{note.folio || "Folio"}</span>
            <span>
              {note.words === undefined ? "—" : plural(note.words, "word")} ·{" "}
              {plural(note.backlinks ?? 0, "backlink")}
            </span>
          </span>
          <span className="mt-1.5 mb-2 block font-serif text-[22px] leading-[1.15]">
            {note.title}
          </span>
          {note.excerpt && (
            <span className="block text-[14px] leading-[1.55] text-ink-2">
              {note.excerpt.slice(0, 180)}
              {note.excerpt.length > 180 ? "…" : ""}
            </span>
          )}
          {note.tags && note.tags.length > 0 && (
            <span className="mt-2.5 block text-[12.5px] text-accent">
              {note.tags.map((t) => `#${t}`).join(" · ")}
            </span>
          )}
        </span>
      )}
    </a>
  );
}

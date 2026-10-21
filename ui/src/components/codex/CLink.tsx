import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useContext,
  useState,
} from "react";
import { PreviewContext } from "#/components/codex/PreviewContext";
import {
  isModifiedLinkActivation,
  usePreviewTrigger,
} from "#/components/codex/usePreviewTrigger";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import {
  type PreviewTarget,
  previewOpenTarget,
  previewTargetHref,
} from "#/lib/previewTarget";
import { usePreviewStore } from "#/store/preview";
import type { OpenTabTarget } from "#/store/workspace";

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
  target?: PreviewTarget;
  /** Static payload — for inline references that aren't backed by a real page. */
  payload?: CLinkPayload;
  children: ReactNode;
  /** Override click. Defaults to opening the page tab if `path` is set. */
  onClick?: (e: ReactMouseEvent) => void;
  onOpen?: (path: string, label?: string, target?: OpenTabTarget) => void;
  /** Disable navigation entirely. */
  noNavigate?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Trailing resource mark (`[data-link-resource]` in main.css). */
  resource?: string;
};

export function CLink(props: CLinkProps) {
  if (props.onOpen || props.onClick) return <CLinkContent {...props} />;
  return <NavigatingCLink {...props} />;
}

function NavigatingCLink(props: CLinkProps) {
  const openTab = useOpenTab();
  return (
    <CLinkContent
      {...props}
      onOpen={(path, label, target) => {
        if (target?.heading || target?.blockId)
          openTab("page", path, label, target);
        else openTab("page", path);
      }}
    />
  );
}

function CLinkContent({
  path,
  target: suppliedTarget,
  payload,
  children,
  onClick,
  onOpen,
  noNavigate,
  className,
  style,
  resource,
}: CLinkProps) {
  const [hover, setHover] = useState(false);
  const [above, setAbove] = useState(false);
  const target = suppliedTarget ?? (path ? { path } : undefined);
  const preview = usePreviewTrigger(target);
  const parentId = useContext(PreviewContext);

  // Path-backed links route through the window manager; payload-only links
  // (e.g. tag chips) keep the lightweight inline card.
  const note: CLinkPayload | null = payload ?? null;

  const enter = () => {
    if (target) preview.onMouseEnter();
    else {
      const rect = preview.triggerRef.current?.getBoundingClientRect();
      setAbove(!!rect && (rect.top + rect.bottom) / 2 > window.innerHeight / 2);
      setHover(true);
    }
  };
  const leave = () => {
    if (target) preview.onMouseLeave();
    else setHover(false);
  };

  const handleClick = (e: ReactMouseEvent) => {
    if (onClick) {
      onClick(e);
      e.preventDefault();
      return;
    }
    if (noNavigate) {
      e.preventDefault();
      return;
    }
    if (isModifiedLinkActivation(e)) return;
    e.preventDefault();
    if (target) {
      if (parentId) {
        void preview.openReader(e.currentTarget as HTMLElement);
      } else {
        usePreviewStore.getState().closePath(target.path);
        if (target.heading || target.blockId)
          onOpen?.(target.path, undefined, previewOpenTarget(target));
        else onOpen?.(target.path);
      }
    }
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: Inline references are phrasing content; fieldset would invalidate editor paragraphs.
    <span
      role="group"
      aria-label="Page reference"
      className="inline"
      onMouseEnter={enter}
      onMouseLeave={leave}
      onFocus={preview.onFocus}
      onBlur={preview.onBlur}
    >
      <a
        ref={(element) => {
          preview.triggerRef.current = element;
        }}
        href={target ? previewTargetHref(target) : "#"}
        onClick={handleClick}
        className={cn(
          "cl-link relative cursor-pointer",
          FOCUS_RING_NATIVE,
          className,
        )}
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
    </span>
  );
}

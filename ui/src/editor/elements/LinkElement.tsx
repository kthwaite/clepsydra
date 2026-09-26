import {
  autoUpdate,
  FloatingPortal,
  flip,
  offset,
  safePolygon,
  shift,
  useDismiss,
  useFloating,
  useHover,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { Check, Copy, ExternalLink } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useState,
} from "react";
import type { RenderElementProps } from "slate-react";
import { toast } from "sonner";
import { resolveSchemeUrl } from "#/api/deeplink";
import { isSchemeLink, openSchemeLink } from "#/editor/schemeLinks";
import type { LinkElement as LinkElementType } from "#/editor/types";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { classifyLinkResource } from "#/lib/linkResource";
import { resolveLinkTarget } from "#/lib/resourceUrl";

type Props = RenderElementProps & { element: LinkElementType };

/** Trim a long URL for display, keeping the head readable. */
function truncate(url: string, max = 56): string {
  return url.length > max ? `${url.slice(0, max - 1)}…` : url;
}

const LINK_ACTION = cn(
  "flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-ink-2 transition-colors hover:bg-sink hover:text-ink",
  FOCUS_RING_NATIVE,
);

export function LinkElement({ attributes, children, element }: Props) {
  const url = element.url;
  const openTab = useOpenTab();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: "top-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    delay: { open: 220, close: 80 },
    handleClose: safePolygon(),
  });
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    dismiss,
    role,
  ]);

  // Compose Slate's managed ref with floating-ui's reference callback so a
  // single <a> node can be both editable and the popover anchor.
  const slateRef = attributes.ref;
  const setRef = useCallback(
    (node: HTMLAnchorElement | null) => {
      refs.setReference(node);
      if (typeof slateRef === "function") slateRef(node);
      else if (slateRef)
        (slateRef as { current: HTMLAnchorElement | null }).current = node;
    },
    [refs, slateRef],
  );

  const doOpen = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      if (isSchemeLink(url)) {
        void openSchemeLink(url, {
          resolve: resolveSchemeUrl,
          openTab: (type, path) => openTab(type, path),
          notify: (message) => toast.error(message),
        });
      } else {
        const target = resolveLinkTarget(url);
        if (target.kind === "browser") {
          window.open(target.href, "_blank", "noopener,noreferrer");
        } else {
          openTab("page", target.path);
        }
      }
      setOpen(false);
    },
    [url, openTab],
  );

  const doCopy = useCallback(
    async (e: ReactMouseEvent) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      } catch {
        // clipboard unavailable — silently ignore
      }
    },
    [url],
  );

  // ⌘/Ctrl-click still opens directly; plain click keeps placing the caret.
  const onClick = (e: ReactMouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      doOpen(e);
      return;
    }
    e.preventDefault();
  };

  const target = resolveLinkTarget(url);
  const safeHref = target.kind === "browser" ? target.href : undefined;
  const resource = safeHref ? classifyLinkResource(safeHref) : null;

  return (
    <>
      <a
        {...attributes}
        ref={setRef}
        href={safeHref}
        data-link-resource={resource ?? undefined}
        className="cursor-pointer text-accent underline decoration-1 underline-offset-[3px] hover:decoration-2"
        {...getReferenceProps({ onClick })}
      >
        {children}
      </a>
      {open && (
        <FloatingPortal>
          <div
            ref={refs.setFloating}
            style={floatingStyles}
            contentEditable={false}
            className="z-50 flex items-center gap-1 rounded-[16px] bg-raise py-1.5 pl-3.5 pr-1.5 text-[13px] text-ink shadow-lg"
            {...getFloatingProps()}
          >
            <span className="mr-1 max-w-[260px] truncate text-mute" title={url}>
              {truncate(url)}
            </span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={doOpen}
              className={LINK_ACTION}
            >
              <ExternalLink aria-hidden size={13} /> Open
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={doCopy}
              className={LINK_ACTION}
            >
              {copied ? (
                <Check aria-hidden size={13} />
              ) : (
                <Copy aria-hidden size={13} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

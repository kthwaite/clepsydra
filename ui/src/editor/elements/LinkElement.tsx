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

type Props = RenderElementProps & { element: LinkElementType };

/** External links open in the browser; scheme links resolve via the API; everything else is a vault path. */
function isExternal(url: string): boolean {
  return /^(https?:|mailto:)/i.test(url);
}

/** Trim a long URL for display, keeping the head readable. */
function truncate(url: string, max = 56): string {
  return url.length > max ? `${url.slice(0, max - 1)}…` : url;
}

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
      } else if (isExternal(url)) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        openTab("page", url);
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

  const safeHref = isExternal(url) ? url : undefined;

  return (
    <>
      <a
        {...attributes}
        ref={setRef}
        href={safeHref}
        className="cl-link underline decoration-1 underline-offset-2 hover:decoration-2"
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
            className="cl-mono z-50 flex items-center gap-2 border-[1.5px] border-ink bg-paper px-2 py-1 text-[11px] text-ink shadow-[4px_4px_0_0_var(--color-ink)]"
            {...getFloatingProps()}
          >
            <span className="max-w-[260px] truncate text-ink-mute" title={url}>
              {truncate(url)}
            </span>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={doOpen}
              className="flex cursor-pointer items-center gap-1 border-l border-rule-soft pl-2 text-ink hover:text-accent"
            >
              <ExternalLink size={11} /> Open
            </button>
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={doCopy}
              className="flex cursor-pointer items-center gap-1 border-l border-rule-soft pl-2 text-ink hover:text-accent"
            >
              {copied ? <Check size={11} /> : <Copy size={11} />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </FloatingPortal>
      )}
    </>
  );
}

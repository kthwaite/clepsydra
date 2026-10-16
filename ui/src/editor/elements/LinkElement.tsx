import {
  autoUpdate,
  FloatingFocusManager,
  FloatingPortal,
  flip,
  offset,
  safePolygon,
  shift,
  useDismiss,
  useFloating,
  useFocus,
  useHover,
  useInteractions,
  useRole,
} from "@floating-ui/react";
import { Check, Copy, ExternalLink } from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useRef,
  useState,
} from "react";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSlateStatic,
} from "slate-react";
import { toast } from "sonner";
import { resolveSchemeUrl } from "#/api/deeplink";
import { externalPreviewUrl } from "#/api/externalPreviews";
import {
  PreviewAction,
  usePreviewTrigger,
} from "#/components/codex/usePreviewTrigger";
import { InlineSourceEditor } from "#/editor/InlineSourceInput";
import {
  isSessionAt,
  useInlineSourceEditing,
} from "#/editor/inlineSourceEditing";
import { linkSourceAdapter } from "#/editor/linkSourceAdapter";
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

export function LinkElement(props: Props) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const controller = useInlineSourceEditing();
  const session = controller.active;
  const { attributes, children, element } = props;

  // Only a link session needs the path; findPath throws for a detached node.
  if (
    !readOnly &&
    session?.type === "link" &&
    isSessionAt(session, ReactEditor.findPath(editor, element))
  ) {
    // The link is not void: its Slate children stay mounted, hidden, so the
    // DOM mapping holds while the source input has focus.
    return (
      <span {...attributes}>
        <InlineSourceEditor
          adapter={linkSourceAdapter}
          element={element}
          session={session}
        />
        <span hidden>{children}</span>
      </span>
    );
  }

  return <LinkAnchor {...props} />;
}

function LinkAnchor(props: Props) {
  const previewUrl = externalPreviewUrl(props.element.url);
  return previewUrl ? (
    <ExternalLinkAnchor {...props} url={previewUrl} />
  ) : (
    <ActionLinkAnchor {...props} />
  );
}

function ExternalLinkAnchor({
  attributes,
  children,
  url,
}: Props & { url: string }) {
  const readOnly = useReadOnly();
  const preview = usePreviewTrigger({ url }, undefined, {
    previewOnFocus: true,
  });
  return (
    <span {...attributes} className="group/preview">
      <a
        ref={(node) => {
          preview.triggerRef.current = node;
        }}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        data-link-resource={classifyLinkResource(url) ?? undefined}
        tabIndex={0}
        className={cn("cl-link cl-link-underline", FOCUS_RING_NATIVE)}
        onMouseEnter={preview.onMouseEnter}
        onMouseLeave={preview.onMouseLeave}
        onFocus={preview.onFocus}
        onBlur={preview.onBlur}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey) {
            event.preventDefault();
            window.open(url, "_blank", "noopener,noreferrer");
            return;
          }
          event.preventDefault();
          // Editing keeps native caret placement; touch has the Preview action.
          if (readOnly) void preview.openReader();
        }}
        onKeyDown={(event) => {
          preview.onKeyDown(event);
          if (event.defaultPrevented) return;
          if (event.key === "Enter") {
            event.stopPropagation();
            if (
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            event.preventDefault();
            void preview.openReader();
          } else if (event.key === "Tab" || event.key === "Escape") {
            event.stopPropagation();
          }
        }}
      >
        {children}
      </a>
      <span contentEditable={false}>
        <PreviewAction onOpen={preview.openReader} />
      </span>
    </span>
  );
}

function ActionLinkAnchor({ attributes, children, element }: Props) {
  const url = element.url;
  const openTab = useOpenTab();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const suppressRestoredFocus = useRef(false);
  const closePopover = useCallback(() => {
    suppressRestoredFocus.current = true;
    setOpen(false);
    window.requestAnimationFrame(() => {
      suppressRestoredFocus.current = false;
    });
  }, []);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange(nextOpen) {
      if (!nextOpen) closePopover();
      else if (!suppressRestoredFocus.current) setOpen(true);
    },
    placement: "top-start",
    strategy: "fixed",
    middleware: [offset(6), flip(), shift({ padding: 8 })],
    whileElementsMounted: autoUpdate,
  });

  const hover = useHover(context, {
    delay: { open: 220, close: 80 },
    handleClose: safePolygon(),
  });
  const focus = useFocus(context);
  const dismiss = useDismiss(context);
  const role = useRole(context, { role: "dialog" });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    hover,
    focus,
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
      closePopover();
    },
    [url, openTab, closePopover],
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
        tabIndex={0}
        className={cn("cl-link cl-link-underline", FOCUS_RING_NATIVE)}
        {...getReferenceProps({
          onClick,
          onKeyDown(event) {
            // A focused link uses Tab to visit its panel, not to indent the
            // enclosing Slate block. Caret key events still target Editable.
            if (event.key === "Tab" || event.key === "Escape") {
              event.stopPropagation();
            }
          },
        })}
      >
        {children}
      </a>
      {open && (
        <FloatingPortal>
          <FloatingFocusManager
            context={context}
            initialFocus={-1}
            modal={false}
            order={["reference", "content"]}
          >
            <div
              ref={refs.setFloating}
              style={floatingStyles}
              contentEditable={false}
              className="z-50 rounded-xl bg-raise text-[13px] text-ink shadow-lg"
              {...getFloatingProps({
                "aria-label": "Link preview",
                onKeyDown(event) {
                  event.stopPropagation();
                },
              })}
            >
              <div className="flex items-center gap-1 py-1.5 pl-3.5 pr-1.5">
                <span
                  className="mr-1 min-w-0 max-w-[260px] flex-1 truncate text-mute"
                  title={url}
                >
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
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

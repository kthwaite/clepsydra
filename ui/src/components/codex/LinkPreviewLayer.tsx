import {
  ArrowLeft,
  ArrowUpRight,
  Copy,
  Globe,
  Maximize2,
  Minimize2,
  Minus,
  Pin,
  X,
} from "lucide-react";
import {
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { createPortal } from "react-dom";
import { usePageBaseProperties } from "#/api/bases";
import { useBacklinks } from "#/api/index";
import { usePage } from "#/api/pages";
import { ExternalPreviewReader } from "#/components/codex/ExternalPreviewReader";
import { shortFolio } from "#/components/codex/folio-utils";
import { PreviewBody } from "#/components/codex/PreviewBody";
import {
  PreviewContext,
  PreviewRestrictionsContext,
} from "#/components/codex/PreviewContext";
import { KindIcon } from "#/components/KindIcon";
import { WikilinkResolutionProvider } from "#/editor/wikilinkResolution";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { resolveKind } from "#/lib/kind";
import {
  isExternalPreviewTarget,
  type PreviewTarget,
  previewOpenTarget,
} from "#/lib/previewTarget";
import { type PreviewWindow as PW, usePreviewStore } from "#/store/preview";

const PreviewReader = lazy(() =>
  import("#/components/codex/PreviewReader").then((module) => ({
    default: module.PreviewReader,
  })),
);
const SHEET_QUERY = "(max-width: 640px), (pointer: coarse)";

function useSheetPresentation() {
  const [sheet, setSheet] = useState(
    () => typeof matchMedia !== "undefined" && matchMedia(SHEET_QUERY).matches,
  );
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const media = matchMedia(SHEET_QUERY);
    const update = () => {
      setSheet(media.matches);
      usePreviewStore.getState().clampAll();
    };
    media.addEventListener("change", update);
    window.addEventListener("resize", update);
    window.visualViewport?.addEventListener("resize", update);
    return () => {
      media.removeEventListener("change", update);
      window.removeEventListener("resize", update);
      window.visualViewport?.removeEventListener("resize", update);
    };
  }, []);
  return sheet;
}

function returnFocus(win: PW, windows: PW[]) {
  const opener = win.opener;
  if (opener?.isConnected && !opener.closest("[hidden], [inert]")) {
    opener.dataset.previewFocusRestore = "true";
    opener.focus({ preventScroll: true });
    delete opener.dataset.previewFocusRestore;
    return;
  }
  const parent = windows.find(
    (item) => item.id === win.parentId && !item.minimized,
  );
  const fallback =
    parent && document.getElementById(`preview-surface-${parent.id}`);
  const host = document.querySelector<HTMLElement>(
    "main [tabindex], main button, main a, [role=main] [tabindex]",
  );
  (fallback || host)?.focus({ preventScroll: true });
}

export function LinkPreviewLayer() {
  const windows = usePreviewStore((state) => state.windows);
  const sheet = useSheetPresentation();
  const visible = windows.filter(
    (win) => !win.minimized && (!sheet || win.mode === "reader"),
  );
  const active = visible.reduce<PW | undefined>(
    (top, win) => (!top || win.z > top.z ? win : top),
    undefined,
  );
  const minimized = windows.filter((win) => win.minimized);

  useEffect(
    () =>
      usePreviewStore.subscribe((state, previous) => {
        const focused = previous.windows.find((win) =>
          document
            .getElementById(`preview-surface-${win.id}`)
            ?.contains(document.activeElement),
        );
        if (
          focused &&
          !state.windows.some((win) => win.id === focused.id && !win.minimized)
        ) {
          queueMicrotask(() =>
            returnFocus(focused, usePreviewStore.getState().windows),
          );
        }
      }),
    [],
  );

  useEffect(() => {
    let focusedFrame: string | undefined;
    let pending = 0;
    const reconcileFrameFocus = () => {
      pending = 0;
      const active = document.activeElement;
      const surface =
        active instanceof HTMLIFrameElement
          ? active.closest<HTMLElement>("[id^='preview-surface-']")
          : null;
      const id = surface?.id.slice("preview-surface-".length);
      const state = usePreviewStore.getState();
      if (focusedFrame && focusedFrame !== id) {
        const previous = document.getElementById(
          `preview-surface-${focusedFrame}`,
        );
        if (!previous?.contains(active)) state.focusWithin(focusedFrame, false);
      }
      if (id && id !== focusedFrame) {
        state.raise(id);
        state.focusWithin(id, true);
      }
      focusedFrame = id;
    };
    const schedule = () => {
      cancelAnimationFrame(pending);
      pending = requestAnimationFrame(reconcileFrameFocus);
    };
    // Cross-origin frame pointer/key events never bubble into the window shell.
    window.addEventListener("blur", schedule);
    window.addEventListener("focus", schedule);
    document.addEventListener("focusin", schedule);
    return () => {
      cancelAnimationFrame(pending);
      window.removeEventListener("blur", schedule);
      window.removeEventListener("focus", schedule);
      document.removeEventListener("focusin", schedule);
    };
  }, []);

  useEffect(() => {
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing)
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          '[role="menu"], [role="listbox"], [contenteditable="true"], input, textarea',
        )
      )
        return;
      const state = usePreviewStore.getState();
      const top = state.windows
        .filter((win) => !win.minimized)
        .reduce<PW | undefined>(
          (best, win) => (!best || win.z > best.z ? win : best),
          undefined,
        );
      if (top) {
        event.preventDefault();
        state.close(top.id);
        if (sheet && top.parentId) state.raise(top.parentId);
      }
    };
    document.addEventListener("keydown", dismissOnEscape);
    return () => document.removeEventListener("keydown", dismissOnEscape);
  }, [sheet]);

  if (typeof document === "undefined") return null;

  const closeStack = () => {
    if (!active) return;
    const state = usePreviewStore.getState();
    let root = active;
    while (root.parentId) {
      const parent = state.windows.find((win) => win.id === root.parentId);
      if (!parent) break;
      root = parent;
    }
    const belongs = (win: PW): boolean => {
      if (win.id === root.id) return true;
      const parent = state.windows.find((item) => item.id === win.parentId);
      return !!parent && belongs(parent);
    };
    const stack = state.windows.filter(belongs);
    for (let index = stack.length - 1; index >= 0; index--)
      state.close(stack[index].id);
  };

  return createPortal(
    <>
      {sheet ? (
        <ModalOverlay
          isOpen={!!active}
          isKeyboardDismissDisabled
          onOpenChange={(open) => {
            if (!open) closeStack();
          }}
          className="fixed inset-0 z-[1000] bg-scrim p-2"
        >
          <Modal className="h-full max-h-[calc(var(--visual-viewport-height,100dvh)-1rem)] w-full overflow-hidden rounded-2xl bg-raise shadow-lg">
            <Dialog
              aria-labelledby={
                active ? `preview-label-${active.id}` : undefined
              }
              className="h-full outline-none"
            >
              {windows.map((win) => (
                <PreviewWindow
                  key={win.id}
                  win={win}
                  sheet
                  hidden={win.id !== active?.id}
                  closeStack={closeStack}
                />
              ))}
            </Dialog>
          </Modal>
        </ModalOverlay>
      ) : (
        windows.map((win) => (
          <PreviewWindow key={win.id} win={win} hidden={win.minimized} />
        ))
      )}
      {minimized.length > 0 ? <Tray windows={minimized} /> : null}
    </>,
    document.body,
  );
}

type WindowProps = {
  win: PW;
  sheet?: boolean;
  hidden: boolean;
  closeStack?: () => void;
};

function windowLabel(win: PW) {
  return isExternalPreviewTarget(win)
    ? new URL(win.url).hostname
    : shortFolio(win.path);
}

function PreviewWindow(props: WindowProps) {
  const { win } = props;
  if (!isExternalPreviewTarget(win)) {
    return <PagePreviewWindow {...props} win={win} />;
  }
  return (
    <PreviewWindowFrame
      {...props}
      title={win.url}
      icon={<Globe size={14} className="shrink-0" />}
      onOpen={() => window.open(win.url, "_blank", "noopener,noreferrer")}
    >
      {() => <ExternalPreviewReader key={win.url} url={win.url} />}
    </PreviewWindowFrame>
  );
}

function PagePreviewWindow(props: WindowProps & { win: PW & PreviewTarget }) {
  const { win } = props;
  const query = usePage(win.path);
  const page = query.data;
  const { data: backlinks } = useBacklinks(win.path);
  const projection = usePageBaseProperties(page?.meta.id ?? "");
  const openTab = useOpenTab();
  const title = page?.meta.title || win.path;
  const missing =
    query.isError &&
    typeof query.error === "object" &&
    query.error !== null &&
    "status" in query.error &&
    query.error.status === 404;
  const unavailable = query.isError || !page;
  return (
    <PreviewWindowFrame
      {...props}
      title={title}
      icon={
        <KindIcon
          kind={resolveKind({
            path: win.path,
            body: page?.encrypted ? undefined : page?.body,
          })}
          size={14}
          className="shrink-0"
        />
      }
      onOpen={() => openTab("page", win.path, title, previewOpenTarget(win))}
    >
      {(scroller) => (
        <WikilinkResolutionProvider path={win.path}>
          <PreviewBody
            path={win.path}
            page={unavailable ? undefined : page}
            backlinks={backlinks}
            preview={projection.data?.preview}
            previewPending={projection.isPending}
            previewError={projection.isError}
            showContent={win.mode === "peek" && !unavailable}
            showTags
          />
          {query.isPending ? (
            <p role="status" className="px-4 pb-4 text-sm text-mute">
              Loading page…
            </p>
          ) : missing ? (
            <p role="status" className="px-4 pb-4 text-sm text-mute">
              This page is unavailable. It may have been moved or deleted.
            </p>
          ) : query.isError ? (
            <div role="alert" className="px-4 pb-4 text-sm text-mute">
              <p>Could not load this page.</p>
              <button
                type="button"
                className={cn(
                  "mt-2 rounded-full text-accent",
                  FOCUS_RING_NATIVE,
                )}
                onClick={() => void query.refetch()}
              >
                Retry
              </button>
            </div>
          ) : null}
          {page && !unavailable && !page.encrypted && win.mode === "reader" ? (
            <Suspense
              fallback={
                <p role="status" className="px-4 pb-4 text-sm text-mute">
                  Loading reader…
                </p>
              }
            >
              <PreviewReader
                target={win}
                body={page.body}
                restricted={win.restricted}
                scrollRoot={scroller}
              />
            </Suspense>
          ) : null}
        </WikilinkResolutionProvider>
      )}
    </PreviewWindowFrame>
  );
}

function PreviewWindowFrame({
  win,
  sheet = false,
  hidden,
  closeStack,
  title,
  icon,
  onOpen,
  children,
}: WindowProps & {
  title: string;
  icon: ReactNode;
  onOpen: () => void;
  children: (scroller: RefObject<HTMLElement | null>) => ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLElement>(null);
  const requestedFocus = useRef(0);
  const drag = useRef<{
    kind: "move" | "resize";
    x: number;
    y: number;
    width: number;
    height: number;
    left: number;
    top: number;
  } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [copied, setCopied] = useState(false);
  const external = isExternalPreviewTarget(win);
  const state = usePreviewStore.getState;

  useLayoutEffect(() => {
    if (hidden || win.focusRequest <= requestedFocus.current) return;
    requestedFocus.current = win.focusRequest;
    scroller.current?.focus({ preventScroll: true });
  }, [hidden, win.focusRequest]);

  useEffect(() => {
    if (!dragging) return;
    let frame = 0;
    let pending: { x: number; y: number } | undefined;
    const flush = () => {
      frame = 0;
      const start = drag.current;
      if (!start || !pending) return;
      if (start.kind === "move")
        state().move(
          win.id,
          start.left + pending.x - start.x,
          start.top + pending.y - start.y,
        );
      else
        state().resize(
          win.id,
          start.width + pending.x - start.x,
          start.height + pending.y - start.y,
        );
    };
    const move = (event: PointerEvent) => {
      pending = { x: event.clientX, y: event.clientY };
      if (!frame) frame = requestAnimationFrame(flush);
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      flush();
      const current = state().windows.find((item) => item.id === win.id);
      if (current && drag.current?.kind === "move")
        state().commitMove(win.id, current.x, current.y);
      drag.current = null;
      setDragging(false);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [dragging, win.id]);

  const beginDrag = (event: React.PointerEvent, kind: "move" | "resize") => {
    if (sheet || win.maximized || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (external && win.mode === "peek") state().expand(win.id);
    state().raise(win.id);
    drag.current = {
      kind,
      x: event.clientX,
      y: event.clientY,
      width: win.width,
      height: win.height,
      left: win.x,
      top: win.y,
    };
    setDragging(true);
  };

  return (
    <PreviewContext value={win.id}>
      <PreviewRestrictionsContext value={win.restricted ?? false}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions lint/a11y/useAriaPropsSupportedByRole: Both dynamic roles support accessible names and own pointer/focus lifetime; actions are native buttons. */}
        <div
          ref={surface}
          id={`preview-surface-${win.id}`}
          role={sheet ? "group" : "dialog"}
          aria-label={`Preview ${title}`}
          tabIndex={-1}
          hidden={hidden}
          inert={hidden}
          style={
            sheet
              ? { height: "100%" }
              : {
                  left: win.x,
                  top: win.y,
                  width: win.width,
                  height:
                    win.mode === "reader" || external ? win.height : undefined,
                  maxHeight: `calc(100dvh - ${win.y + 8}px)`,
                  zIndex: win.z,
                }
          }
          onMouseEnter={() => state().enter(win.id)}
          onMouseLeave={() => state().leave(win.id)}
          onFocusCapture={() => {
            state().focusWithin(win.id, true);
            state().raise(win.id);
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget))
              state().focusWithin(win.id, false);
          }}
          onPointerDown={() => state().raise(win.id)}
          className={cn(
            "cursor-default flex-col overflow-hidden rounded-2xl bg-raise text-ink shadow-lg",
            hidden ? "hidden" : "flex",
            !sheet && "fixed",
          )}
        >
          <span id={`preview-label-${win.id}`} className="sr-only">
            Preview {title}
          </span>
          <div
            onPointerDown={(event) => beginDrag(event, "move")}
            className={cn(
              "flex shrink-0 items-center gap-2 bg-sink py-1.5 pr-1.5 pl-3",
              !sheet && "cursor-grab touch-none active:cursor-grabbing",
            )}
          >
            {sheet && win.parentId ? (
              <IconBtn
                label="Back"
                onClick={() => {
                  state().close(win.id);
                  if (win.parentId) state().raise(win.parentId);
                }}
              >
                <ArrowLeft size={16} />
              </IconBtn>
            ) : null}
            {icon}
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-mute">
              {windowLabel(win)}
            </span>
            {win.mode === "peek" && !external ? (
              <IconBtn
                label="Expand preview"
                onClick={() => state().expand(win.id)}
              >
                <Maximize2 size={14} />
              </IconBtn>
            ) : null}
            {!sheet ? (
              <IconBtn
                label={
                  win.maximized ? "Restore preview size" : "Maximize preview"
                }
                onClick={() => state().toggleMaximize(win.id)}
              >
                {win.maximized ? (
                  <Minimize2 size={14} />
                ) : (
                  <Maximize2 size={14} />
                )}
              </IconBtn>
            ) : null}
            <IconBtn
              label={win.pinned ? "Unpin preview" : "Pin preview"}
              active={win.pinned}
              onClick={() =>
                win.pinned ? state().unpin(win.id) : state().pin(win.id)
              }
            >
              <Pin size={14} fill={win.pinned ? "currentColor" : "none"} />
            </IconBtn>
            <IconBtn
              label="Minimize preview"
              onClick={() => state().minimize(win.id)}
            >
              <Minus size={14} />
            </IconBtn>
            <IconBtn
              label={external ? "Open link" : "Open page"}
              onClick={() => {
                onOpen();
                if (sheet) {
                  // Park readers so no modal obscures the destination; pins remain saved.
                  for (const reader of state().windows) {
                    if (reader.mode === "reader") state().minimize(reader.id);
                  }
                  state().closePeeks();
                }
              }}
            >
              <ArrowUpRight size={16} />
            </IconBtn>
            {isExternalPreviewTarget(win) ? (
              <IconBtn
                label={copied ? "Copied link" : "Copy link"}
                onClick={() => {
                  void navigator.clipboard.writeText(win.url).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                }}
              >
                <Copy size={14} />
              </IconBtn>
            ) : null}
            <IconBtn
              label="Close preview"
              onClick={() => (sheet ? closeStack?.() : state().close(win.id))}
            >
              <X size={16} />
            </IconBtn>
          </div>
          {/* Keyboard focus makes the bounded reading surface scrollable without a pointer. */}
          <section
            ref={scroller}
            data-preview-scroll
            aria-label={`Reading ${title}`}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: A labelled scroll region needs keyboard focus for scrolling.
            tabIndex={0}
            className={cn(
              "relative min-h-0 flex-1 overflow-y-auto overscroll-contain",
              FOCUS_RING_NATIVE,
              external && "flex flex-col",
            )}
          >
            {children(scroller)}
            {dragging ? (
              <div className="absolute inset-0 z-10" aria-hidden />
            ) : null}
          </section>
          {!sheet && !win.maximized && (win.mode === "reader" || external) ? (
            <button
              type="button"
              aria-label="Resize preview"
              className={cn(
                "absolute right-0 bottom-0 h-5 w-5 cursor-se-resize rounded-tl-lg bg-sink touch-none",
                FOCUS_RING_NATIVE,
              )}
              onPointerDown={(event) => beginDrag(event, "resize")}
              onKeyDown={(event) => {
                const delta = event.shiftKey ? 50 : 10;
                if (
                  !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                state().resize(
                  win.id,
                  win.width +
                    (event.key === "ArrowLeft"
                      ? -delta
                      : event.key === "ArrowRight"
                        ? delta
                        : 0),
                  win.height +
                    (event.key === "ArrowUp"
                      ? -delta
                      : event.key === "ArrowDown"
                        ? delta
                        : 0),
                );
              }}
            />
          ) : null}
        </div>
      </PreviewRestrictionsContext>
    </PreviewContext>
  );
}

function Tray({ windows }: { windows: PW[] }) {
  return (
    <div className="fixed bottom-3 left-3 z-[950] flex max-w-[90vw] flex-wrap gap-2">
      {windows.map((win) => (
        <div
          key={win.id}
          className="flex h-9 items-center gap-1 rounded-full bg-raise pr-1.5 pl-4 shadow-md"
        >
          <button
            type="button"
            onClick={() => usePreviewStore.getState().restore(win.id)}
            className={cn(
              "cursor-pointer rounded-full text-[13px] text-ink hover:text-accent",
              FOCUS_RING_NATIVE,
            )}
          >
            {windowLabel(win)}
          </button>
          <IconBtn
            label={`Close preview ${windowLabel(win)}`}
            onClick={() => usePreviewStore.getState().close(win.id)}
          >
            <X size={13} />
          </IconBtn>
        </div>
      ))}
    </div>
  );
}

function IconBtn({
  children,
  label,
  onClick,
  active,
}: {
  children: React.ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        "flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full",
        FOCUS_RING_NATIVE,
        active
          ? "bg-accent-tint text-accent"
          : "text-mute hover:bg-raise hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}

import { Maximize2, Minus, Pin, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePageBaseProperties } from "#/api/bases";
import { useBacklinks } from "#/api/index";
import { usePage } from "#/api/pages";
import { shortFolio } from "#/components/codex/folio-utils";
import { PreviewBody } from "#/components/codex/PreviewBody";
import { KindIcon } from "#/components/KindIcon";
import { useOpenTab } from "#/hooks/useOpenTab";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
import { resolveKind } from "#/lib/kind";
import {
  cancelHoverClose,
  PREVIEW_WIDTH,
  type PreviewWindow as PW,
  scheduleHoverClose,
  usePreviewStore,
} from "#/store/preview";

export function LinkPreviewLayer() {
  const windows = usePreviewStore((s) => s.windows);
  if (typeof document === "undefined") return null;

  const open = windows.filter((w) => !w.minimized);
  const minimized = windows.filter((w) => w.minimized);

  return createPortal(
    <>
      {open.map((w) => (
        <PreviewWindow key={w.id} win={w} />
      ))}
      {minimized.length > 0 && <Tray windows={minimized} />}
    </>,
    document.body,
  );
}

function PreviewWindow({ win }: { win: PW }) {
  const { data: page } = usePage(win.path);
  const { data: backlinks } = useBacklinks(win.path);
  const projection = usePageBaseProperties(page?.meta.id ?? "");
  const openTab = useOpenTab();
  const pin = usePreviewStore((state) => state.pin);
  const minimize = usePreviewStore((state) => state.minimize);
  const close = usePreviewStore((state) => state.close);
  const raise = usePreviewStore((state) => state.raise);
  const move = usePreviewStore((state) => state.move);
  const commitMove = usePreviewStore((state) => state.commitMove);
  const dragRef = useRef<{ ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    // pointermove fires far faster than we can paint; coalesce to one store
    // write per frame so the drag doesn't thrash React renders.
    let raf = 0;
    let pending: { x: number; y: number } | null = null;
    const flush = () => {
      raf = 0;
      if (pending) move(win.id, pending.x, pending.y);
    };
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      pending = { x: e.clientX - d.ox, y: e.clientY - d.oy };
      if (!raf) raf = requestAnimationFrame(flush);
    };
    const onUp = () => {
      if (pending) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
        commitMove(win.id, pending.x, pending.y);
      }
      setDragging(false);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [commitMove, dragging, win.id, move]);

  const onTitlePointerDown = (e: React.PointerEvent) => {
    raise(win.id);
    // An `above` window's `y` is its bottom edge, so measure its rendered
    // top. Moves then write top-left coordinates and drop `above`.
    const top = win.above
      ? (e.currentTarget.parentElement?.getBoundingClientRect().top ?? win.y)
      : win.y;
    dragRef.current = { ox: e.clientX - win.x, oy: e.clientY - top };
    setDragging(true);
  };

  const title = page?.meta.title || win.path;
  const kind = resolveKind({
    path: win.path,
    body: page?.encrypted ? undefined : page?.body,
  });

  return (
    <div
      role="dialog"
      aria-label={`Preview ${title}`}
      style={{
        left: 0,
        top: 0,
        transform: `translate3d(${win.x}px, ${win.y}px, 0)${win.above ? " translateY(-100%)" : ""}`,
        width: PREVIEW_WIDTH,
        zIndex: win.z,
      }}
      onMouseEnter={cancelHoverClose}
      onMouseLeave={() => {
        if (!win.pinned) scheduleHoverClose();
      }}
      onPointerDown={() => raise(win.id)}
      className="fixed cursor-default overflow-hidden rounded-2xl bg-raise text-ink shadow-lg"
    >
      {/* titlebar */}
      <div
        onPointerDown={onTitlePointerDown}
        className="flex cursor-grab items-center gap-2 bg-sink py-1.5 pr-1.5 pl-4 active:cursor-grabbing"
      >
        <KindIcon kind={kind} size={14} className="flex-shrink-0" />
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-mute">
          {shortFolio(win.path)}
        </span>
        <IconBtn
          label={win.pinned ? "unpin" : "pin"}
          onClick={() => (win.pinned ? close(win.id) : pin(win.id))}
          active={win.pinned}
        >
          <Pin size={14} fill={win.pinned ? "currentColor" : "none"} />
        </IconBtn>
        <IconBtn label="minimize" onClick={() => minimize(win.id)}>
          <Minus size={14} />
        </IconBtn>
        <IconBtn label="open" onClick={() => openTab("page", win.path, title)}>
          <Maximize2 size={13} />
        </IconBtn>
        <IconBtn label="close" onClick={() => close(win.id)}>
          <X size={14} />
        </IconBtn>
      </div>

      {/* body */}
      <PreviewBody
        path={win.path}
        page={page}
        backlinks={backlinks}
        preview={projection.data?.preview}
        previewPending={projection.isPending}
        previewError={projection.isError}
        showTags
      />
    </div>
  );
}

function Tray({ windows }: { windows: PW[] }) {
  const restore = usePreviewStore((state) => state.restore);
  const close = usePreviewStore((state) => state.close);
  return (
    <div className="fixed bottom-3 left-3 z-[950] flex max-w-[60vw] flex-wrap gap-2">
      {windows.map((w) => (
        <div
          key={w.id}
          className="flex h-9 items-center gap-1 rounded-full bg-raise pr-1.5 pl-4 shadow-md"
        >
          <button
            type="button"
            onClick={() => restore(w.id)}
            className={cn(
              "cursor-pointer rounded-full text-[13px] text-ink hover:text-accent",
              FOCUS_RING_NATIVE,
            )}
          >
            {shortFolio(w.path)}
          </button>
          <button
            type="button"
            onClick={() => close(w.id)}
            aria-label="close"
            className={cn(
              "flex h-7 w-7 cursor-pointer items-center justify-center rounded-full text-mute hover:bg-sink hover:text-hot",
              FOCUS_RING_NATIVE,
            )}
          >
            <X size={13} />
          </button>
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
      onPointerDown={(e) => e.stopPropagation()}
      className={cn(
        "flex h-7 w-7 cursor-pointer items-center justify-center rounded-full",
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

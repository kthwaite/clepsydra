import { Maximize2, Minus, Pin, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBacklinks } from "#/api/index";
import { usePage } from "#/api/pages";
import {
  countWords,
  firstParagraph,
  shortFolio,
} from "#/components/codex/folio-utils";
import { useOpenTab } from "#/hooks/useOpenTab";
import { kindColorVar, kindLabel, resolveKind } from "#/lib/kind";
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
  const openTab = useOpenTab();
  const { pin, minimize, close, raise, move } = usePreviewStore();
  const dragRef = useRef<{ ox: number; oy: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      move(win.id, e.clientX - d.ox, e.clientY - d.oy);
    };
    const onUp = () => setDragging(false);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [dragging, win.id, move]);

  const onTitlePointerDown = (e: React.PointerEvent) => {
    raise(win.id);
    dragRef.current = { ox: e.clientX - win.x, oy: e.clientY - win.y };
    setDragging(true);
  };

  const title = page?.meta.title || win.path;
  const kind = resolveKind({ path: win.path, body: page?.body });
  const excerpt = page ? firstParagraph(page.body) : "";
  const words = page ? countWords(page.body) : 0;
  const tags = page?.meta.tags ?? [];

  return (
    <div
      style={{ left: win.x, top: win.y, width: PREVIEW_WIDTH, zIndex: win.z }}
      onMouseEnter={cancelHoverClose}
      onMouseLeave={() => {
        if (!win.pinned) scheduleHoverClose();
      }}
      onPointerDown={() => raise(win.id)}
      className="fixed cursor-default border-[1.5px] border-ink bg-paper text-ink shadow-[0_14px_40px_rgba(0,0,0,0.7),0_0_0_1px_var(--color-bg)] font-body"
    >
      {/* titlebar */}
      <div
        onPointerDown={onTitlePointerDown}
        className="flex cursor-grab items-center gap-1.5 border-b border-ink bg-paper-2 px-2 py-1 active:cursor-grabbing"
      >
        <span
          className="inline-block h-[6px] w-[6px] flex-shrink-0"
          style={{ background: kindColorVar(kind) }}
        />
        <span className="cl-mono flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-[9px] uppercase tracking-[0.12em] text-ink-mute">
          ⟦ {shortFolio(win.path)} ⟧
        </span>
        <IconBtn
          label={win.pinned ? "unpin" : "pin"}
          onClick={() => (win.pinned ? close(win.id) : pin(win.id))}
          active={win.pinned}
        >
          <Pin size={11} fill={win.pinned ? "currentColor" : "none"} />
        </IconBtn>
        <IconBtn label="minimize" onClick={() => minimize(win.id)}>
          <Minus size={11} />
        </IconBtn>
        <IconBtn label="open" onClick={() => openTab("page", win.path, title)}>
          <Maximize2 size={10} />
        </IconBtn>
        <IconBtn label="close" onClick={() => close(win.id)}>
          <X size={11} />
        </IconBtn>
      </div>

      {/* body */}
      <div className="px-[10px] py-2">
        <div className="mb-1 flex items-baseline justify-between border-b border-rule-soft pb-[3px]">
          <span className="cl-mono text-[9px] uppercase tracking-[0.12em] text-ink-mute">
            {kindLabel(kind)}
          </span>
          <span className="cl-mono text-[9px] text-ink-mute">
            {words} wd · ↘{backlinks?.length ?? 0}
          </span>
        </div>
        <div className="mb-[3px] font-sans text-[14px] font-bold leading-[1.2]">
          {title}
        </div>
        {excerpt && (
          <p className="m-0 font-sans text-[11.5px] leading-[1.45] text-ink-mute">
            {excerpt.slice(0, 200)}
            {excerpt.length > 200 ? "…" : ""}
          </p>
        )}
        {tags.length > 0 && (
          <div className="cl-mono mt-[5px] border-t border-dotted border-rule-soft pt-1 text-[9px] text-accent">
            {tags.map((t) => `#${t}`).join(" ")}
          </div>
        )}
      </div>
    </div>
  );
}

function Tray({ windows }: { windows: PW[] }) {
  const { restore, close } = usePreviewStore();
  return (
    <div className="fixed bottom-2 left-2 z-[950] flex max-w-[60vw] flex-wrap gap-1.5">
      {windows.map((w) => (
        <div
          key={w.id}
          className="flex items-center gap-1.5 border border-ink bg-paper-2 px-2 py-1 shadow-[0_6px_18px_rgba(0,0,0,0.6)]"
        >
          <button
            type="button"
            onClick={() => restore(w.id)}
            className="cl-mono cursor-pointer text-[10px] text-ink hover:text-accent"
          >
            ⟦ {shortFolio(w.path)} ⟧
          </button>
          <button
            type="button"
            onClick={() => close(w.id)}
            aria-label="close"
            className="cursor-pointer text-ink-mute hover:text-hot"
          >
            <X size={10} />
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
      className={`flex cursor-pointer items-center p-[1px] ${
        active ? "text-accent" : "text-ink-mute hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Element as SlateElement, Transforms } from "slate";
import type { RenderElementProps } from "slate-react";
import { ReactEditor, useSelected, useSlateStatic } from "slate-react";
import { BaseEmbedInspector } from "#/components/bases/BaseEmbedInspector";
import type { BaseTableViewHandle } from "#/components/bases/BaseTableView";
import {
  clampEmbedWidth,
  EMBED_WIDTH_FALLBACK,
  EMBED_WIDTH_MAX,
  EMBED_WIDTH_MIN,
  EMBED_WIDTH_STEP,
  embedIsCompact,
  embedWidthStyle,
} from "#/components/bases/embed-presentation";
import { useWidthDrag, WidthResizer } from "#/components/ui/width-resizer";
import { useBaseEmbedEditing } from "#/editor/baseEmbedEditing";
import type { BaseEmbedElement as BaseEmbedNode } from "#/editor/types";
import { EmbeddedBaseTable } from "./EmbeddedBaseTable";

interface BaseEmbedElementProps extends RenderElementProps {
  element: BaseEmbedNode;
}

function focusConnected(control: HTMLButtonElement | null): boolean {
  if (!control?.isConnected || control.disabled) return false;
  control.focus();
  return document.activeElement === control;
}

export function BaseEmbedElement({
  attributes,
  children,
  element,
}: BaseEmbedElementProps) {
  const editor = useSlateStatic();
  const editing = useBaseEmbedEditing();
  const selected = useSelected();
  const path = ReactEditor.findPath(editor, element);
  const tableRef = useRef<BaseTableViewHandle>(null);
  const editRef = useRef<HTMLButtonElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const {
    begin,
    cancel,
    commit,
    disposeNode,
    exit,
    isActive,
    registerEntryFocus,
    remove,
    restoreFocus,
  } = editing;
  const active = isActive(path);

  const entryFocus = useMemo(
    () => ({
      focusEntry() {
        return (
          (tableRef.current?.focusEntry() ?? false) ||
          focusConnected(editRef.current) ||
          focusConnected(removeRef.current)
        );
      },
      focusEdit() {
        return focusConnected(editRef.current);
      },
    }),
    [],
  );

  useLayoutEffect(() => {
    const unregister = registerEntryFocus(element, entryFocus);
    return () => {
      unregister();
      disposeNode(element);
    };
  }, [disposeNode, element, entryFocus, registerEntryFocus]);

  const openInspector = useCallback(() => {
    begin(ReactEditor.findPath(editor, element));
  }, [begin, editor, element]);

  const removeEmbed = useCallback(() => {
    remove(path, element);
  }, [element, path, remove]);

  const handleGuardKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    side: "before" | "after",
  ) => {
    if (event.defaultPrevented || event.key !== "Tab") return;
    if (side === "before" && !event.shiftKey) return;
    if (side === "after" && event.shiftKey) return;
    event.preventDefault();
    event.stopPropagation();
    exit(path, side);
  };

  const handleInteractiveKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    exit(path, "after");
  };

  // Compact embeds have no header of their own: the same two controls move
  // into the table's toolbar, keeping one set of refs for entry focus.
  const compact = element.status === "configured" && embedIsCompact(element);
  const authoredWidth =
    element.status === "configured" ? element.width : undefined;
  const setWidth = useCallback(
    (width: number | undefined) => {
      Transforms.setNodes(
        editor,
        { width: width === undefined ? undefined : clampEmbedWidth(width) },
        {
          at: path,
          // Matched by type, not identity: successive resizes must not depend
          // on this closure still holding the node the last one replaced.
          match: (node) =>
            SlateElement.isElement(node) && node.type === "base-embed",
          voids: true,
        },
      );
    },
    [editor, path],
  );
  // While dragging, the width is only a preview: one undo entry per animation
  // frame would bury the edit that put the embed there.
  const [previewWidth, setPreviewWidth] = useState<number | undefined>(
    undefined,
  );
  const [measuredWidth, setMeasuredWidth] = useState(0);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = bodyRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setMeasuredWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  // Nothing authored: the splitter reports what the embed actually occupies,
  // and the default only until the first measurement arrives.
  const occupied = measuredWidth > 0 ? measuredWidth : EMBED_WIDTH_FALLBACK;
  const resizerWidth = clampEmbedWidth(
    previewWidth ?? authoredWidth ?? occupied,
  );
  const widthDrag = useWidthDrag({
    width: resizerWidth,
    onPreview: setPreviewWidth,
    onCommit: (width) => {
      setPreviewWidth(undefined);
      setWidth(width);
    },
  });
  const actions = (
    <>
      <button
        ref={editRef}
        type="button"
        className="cl-mono border border-rule px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink hover:border-accent hover:text-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={openInspector}
      >
        Edit embed
      </button>
      <button
        ref={removeRef}
        type="button"
        aria-label="Remove Base embed"
        className="cl-mono border border-rule px-2 py-1 text-[11px] uppercase tracking-[0.08em] text-ink hover:border-destructive hover:text-destructive focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        onClick={removeEmbed}
      >
        Remove
      </button>
    </>
  );

  return (
    <div
      {...attributes}
      style={embedWidthStyle(previewWidth ?? authoredWidth)}
      className={`relative my-4 min-w-0 rounded border bg-paper transition-colors ${
        selected ? "border-accent ring-1 ring-accent" : "border-rule"
      }`}
      data-testid="base-embed"
    >
      <div
        ref={bodyRef}
        contentEditable={false}
        onKeyDown={handleInteractiveKeyDown}
      >
        {element.status === "configured" ? (
          <WidthResizer
            label="Resize this Base embed"
            width={resizerWidth}
            min={EMBED_WIDTH_MIN}
            max={EMBED_WIDTH_MAX}
            step={EMBED_WIDTH_STEP}
            className="left-auto right-0 translate-x-1/2"
            onWidth={setWidth}
            onReset={() => setWidth(undefined)}
            onDragStart={widthDrag.onDragStart}
          />
        ) : null}
        <span
          aria-label="Exit Base embed before"
          data-testid="base-embed-before-guard"
          tabIndex={0}
          className="sr-only"
          onKeyDown={(event) => handleGuardKeyDown(event, "before")}
        />
        {compact ? null : (
          <header className="flex flex-wrap items-center gap-3 border-b border-rule px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="cl-mono text-[11px] uppercase tracking-[0.14em] text-ink-mute">
                Base embed
              </p>
              <p className="truncate text-sm text-ink">
                {element.status === "configured"
                  ? `${element.base} · ${element.view}`
                  : element.status === "invalid"
                    ? "Persisted configuration needs repair"
                    : "Choose a saved Base and view"}
              </p>
            </div>
            {actions}
          </header>
        )}

        <div className={`min-w-0 ${compact ? "p-2" : "p-3"}`}>
          {element.status === "configured" ? (
            <EmbeddedBaseTable
              ref={tableRef}
              element={element}
              path={path}
              chrome={compact ? "compact" : "full"}
              {...(compact ? { actions } : {})}
            />
          ) : element.status === "invalid" ? (
            <div role="alert" className="text-sm text-destructive">
              <p>
                This Base embed cannot be rendered until its source is repaired.
              </p>
              <p className="cl-mono mt-1 text-xs">{element.parseError}</p>
            </div>
          ) : (
            <p className="text-sm text-ink-mute">
              Configure this embed to render a saved Base view.
            </p>
          )}
        </div>

        <span
          aria-label="Exit Base embed after"
          data-testid="base-embed-after-guard"
          tabIndex={0}
          className="sr-only"
          onKeyDown={(event) => handleGuardKeyDown(event, "after")}
        />

        <BaseEmbedInspector
          isOpen={active}
          node={element}
          onSave={commit}
          onCancel={cancel}
          onRestoreFocus={() => restoreFocus(path)}
        />
      </div>
      {children}
    </div>
  );
}

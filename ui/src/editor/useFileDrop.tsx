import { type DragEvent, useLayoutEffect, useRef, useState } from "react";
import { Editor, type Range, type RangeRef, Text, Transforms } from "slate";
import { ReactEditor } from "slate-react";
import { insertMarkdown } from "#/editor/transforms/insertMarkdown";
import type { CustomEditor } from "#/editor/types";

interface FileDropOptions {
  editor: CustomEditor;
  readOnly: boolean;
  onFilesDrop?: (files: File[]) => Promise<string | null>;
}

interface DropIndicator {
  label: string;
  left: number;
  top: number;
  height: number;
}

function containsFiles(data: DataTransfer): boolean {
  return (
    data.files.length > 0 ||
    Array.from(data.items ?? []).some((item) => item.kind === "file") ||
    Array.from(data.types).includes("Files")
  );
}

function validTarget(editor: Editor, range: Range): boolean {
  const { path, offset } = range.anchor;
  if (!Editor.hasPath(editor, path)) return false;
  const [node] = Editor.node(editor, path);
  return Text.isText(node) && offset >= 0 && offset <= node.text.length;
}

export function useFileDrop({
  editor,
  readOnly,
  onFilesDrop,
}: FileDropOptions) {
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const pending = useRef<{ target: RangeRef } | null>(null);
  const mounted = useRef(false);
  const latest = useRef({ readOnly, onFilesDrop });
  latest.current = { readOnly, onFilesDrop };
  const enabled = !readOnly && Boolean(onFilesDrop);

  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.target.unref();
      pending.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (enabled) return;
    pending.current?.target.unref();
    pending.current = null;
    dragDepth.current = 0;
    setIndicator(null);
    setBusy(false);
    setError(null);
  }, [enabled]);

  function resolveTarget(event: DragEvent<HTMLDivElement>): Range | null {
    try {
      const range = ReactEditor.findEventRange(editor, event);
      const target = { anchor: range.anchor, focus: range.anchor };
      return validTarget(editor, target) ? target : null;
    } catch {
      return null;
    }
  }

  function showTarget(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (!enabled || pending.current) {
      event.dataTransfer.dropEffect = "none";
      setIndicator(null);
      return;
    }
    const range = resolveTarget(event);
    if (!range) {
      event.dataTransfer.dropEffect = "none";
      setIndicator(null);
      return;
    }
    event.dataTransfer.dropEffect = "copy";
    const files = event.dataTransfer.files;
    const count =
      files.length ||
      Array.from(event.dataTransfer.items ?? []).filter(
        (item) => item.kind === "file",
      ).length;
    const label = count > 1 ? `${count} files` : files[0]?.name || "file";
    let left = event.clientX;
    let top = event.clientY;
    let height = 24;
    try {
      const rect = ReactEditor.toDOMRange(
        editor,
        range,
      ).getBoundingClientRect();
      if (rect.height > 0) {
        left = rect.left;
        top = rect.top;
        height = rect.height;
      }
    } catch {
      // Empty blocks can lack a DOM caret box; retain pointer-position feedback.
    }
    setIndicator({ label, left, top, height });
  }

  async function uploadAt(files: File[], target: Range) {
    const upload = latest.current.onFilesDrop;
    if (!upload || latest.current.readOnly || pending.current) return;
    const request = {
      target: Editor.rangeRef(editor, target, { affinity: "forward" }),
    };
    pending.current = request;
    setBusy(true);
    setError(null);
    try {
      const markdown = await upload(files);
      if (
        !mounted.current ||
        latest.current.readOnly ||
        !latest.current.onFilesDrop ||
        pending.current !== request ||
        !markdown
      )
        return;
      const liveTarget = request.target.current;
      if (!liveTarget || !validTarget(editor, liveTarget)) {
        setError(
          "Files uploaded, but the drop position was removed. Insert them from the attachment pane.",
        );
        return;
      }
      // Keep the user's current selection, not the one they had when dropping.
      // The insertion uses a collapsed target and never replaces selected text.
      const selection = editor.selection
        ? Editor.rangeRef(editor, editor.selection)
        : null;
      try {
        Transforms.select(editor, liveTarget.anchor);
        insertMarkdown(editor, markdown);
      } finally {
        const restored = selection?.unref();
        if (restored) Transforms.select(editor, restored);
        else Transforms.deselect(editor);
      }
    } catch (cause) {
      if (mounted.current && pending.current === request) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Could not insert the dropped files.",
        );
      }
    } finally {
      request.target.unref();
      if (pending.current === request) {
        pending.current = null;
        if (mounted.current) setBusy(false);
      }
    }
  }

  const handlers = {
    onDragEnterCapture(event: DragEvent<HTMLDivElement>) {
      if (!containsFiles(event.dataTransfer)) return;
      dragDepth.current += 1;
      showTarget(event);
    },
    onDragOverCapture(event: DragEvent<HTMLDivElement>) {
      if (!containsFiles(event.dataTransfer)) return;
      showTarget(event);
    },
    onDragLeaveCapture(event: DragEvent<HTMLDivElement>) {
      if (!containsFiles(event.dataTransfer) && dragDepth.current === 0) return;
      event.stopPropagation();
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      const next = event.relatedTarget;
      if (next instanceof window.Node && event.currentTarget.contains(next))
        return;
      if (next || dragDepth.current === 0) {
        dragDepth.current = 0;
        setIndicator(null);
      }
    },
    onDragEndCapture() {
      dragDepth.current = 0;
      setIndicator(null);
    },
    // Slate does not invoke its onDrop prop when read-only. Capture prevents
    // browser file navigation there too, without changing text/internal drags.
    onDropCapture(event: DragEvent<HTMLDivElement>) {
      if (!containsFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      dragDepth.current = 0;
      setIndicator(null);
      if (!enabled || pending.current) return;
      const target = resolveTarget(event);
      if (!target) {
        setError("Choose a position in the Folio before dropping files.");
        return;
      }
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0) {
        setError("No files were available in this drop.");
        return;
      }
      void uploadAt(files, target);
    },
  };

  const feedback = (
    <>
      {indicator && (
        <div
          className="pointer-events-none fixed inset-0 z-50"
          aria-live="polite"
        >
          <span
            aria-hidden="true"
            className="fixed w-0.5 rounded-full bg-accent"
            style={{
              left: indicator.left,
              top: indicator.top,
              height: indicator.height,
            }}
          />
          <span
            className="fixed max-w-64 truncate rounded-xl bg-raise px-3 py-2 text-[13px] text-accent shadow-lg"
            style={{
              left: Math.max(
                8,
                Math.min(indicator.left, window.innerWidth - 264),
              ),
              top: Math.min(
                indicator.top + indicator.height + 8,
                window.innerHeight - 48,
              ),
            }}
          >
            Drop {indicator.label}
          </span>
        </div>
      )}
      {busy && (
        <p role="status" className="mt-3 text-[13px] text-mute">
          Preparing dropped files…
        </p>
      )}
      {error && (
        <p
          role="alert"
          className="mt-3 rounded-xl bg-raise px-3 py-2 text-[13px] text-hot"
        >
          {error}
        </p>
      )}
    </>
  );

  return { handlers, feedback };
}

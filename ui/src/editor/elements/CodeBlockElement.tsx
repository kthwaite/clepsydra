import { type ReactNode, useState } from "react";
import { Editor, Transforms } from "slate";
import {
  ReactEditor,
  type RenderElementProps,
  useReadOnly,
  useSelected,
  useSlateStatic,
} from "slate-react";
import {
  MermaidDiagram,
  MermaidViewToggle,
  useMermaidRender,
} from "#/components/MermaidDiagram";
import { CopyButton } from "#/components/ui/CopyButton";
import { displayLabel } from "#/editor/code-languages";
import { CodeLangPicker } from "#/editor/elements/CodeLangPicker";
import { setCodeBlockLanguage } from "#/editor/elements/codeBlockLanguage";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";
import { cn } from "#/lib/cn";
import { MERMAID_LANGUAGE } from "#/lib/markdown/mermaidFence";

type Props = RenderElementProps & { element: CodeBlockElementType };

/**
 * The rendered diagram, sitting outside Slate's editable content. Where the
 * block can be edited it doubles as the way into its source — the same
 * click-or-Enter activation rendered math offers — since a picture leaves the
 * caret nowhere to land.
 */
function ActivatableDiagram({
  children,
  onActivate,
}: {
  children: ReactNode;
  onActivate?: () => void;
}) {
  if (!onActivate) return <div contentEditable={false}>{children}</div>;
  return (
    <div className="relative" contentEditable={false}>
      {children}
      {/* A transparent control over the whole picture: the diagram's own
          markup is flow content, so it cannot live inside the button. */}
      <button
        type="button"
        aria-label="Edit diagram source"
        onMouseDown={(event) => event.preventDefault()}
        onClick={onActivate}
        className="absolute inset-0 cursor-text bg-transparent outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      />
    </div>
  );
}

export function CodeBlockElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const readOnly = useReadOnly();
  const selected = useSelected();
  const [open, setOpen] = useState(false);
  const [diagram, setDiagram] = useState(true);
  // useState (not useRef) so CodeLangPicker re-renders with a non-null
  // reference once the trigger button mounts.
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

  const lang = element.language ?? null;
  const label = lang ? displayLabel(lang) : "TXT";
  const code = element.children.map((c) => c.text).join("");

  // Editing always wins over the diagram: with the caret inside the block the
  // source has to be visible and selectable, whatever the toggle says. The
  // toggle therefore means "render this as a diagram when I'm not in it".
  const editing = selected && !readOnly;
  const wantsDiagram = lang === MERMAID_LANGUAGE && diagram && !editing;
  const state = useMermaidRender(wantsDiagram ? code : null);
  // A diagram that will not parse falls back to its source with the error
  // above it, rather than leaving the block blank.
  const showSource = !wantsDiagram || state.status === "error";

  const handleSelect = (next: string | null) => {
    if (readOnly) {
      setOpen(false);
      return;
    }
    try {
      const path = ReactEditor.findPath(editor, element);
      setCodeBlockLanguage(editor, path, next);
    } catch {
      // The code block was removed before selection — nothing to update.
    }
    setOpen(false);
    ReactEditor.focus(editor);
  };

  const editSource = () => {
    try {
      const path = ReactEditor.findPath(editor, element);
      Transforms.select(editor, Editor.end(editor, path));
    } catch {
      // The block was removed before the click landed — nothing to edit.
      return;
    }
    ReactEditor.focus(editor);
  };

  const handleDiagramToggle = (next: boolean) => {
    setDiagram(next);
    // Rendering the diagram hides the source, so the caret cannot stay in it.
    if (next && editing) Transforms.deselect(editor);
  };

  return (
    <div
      {...attributes}
      className="cl-codeblock group border border-rule bg-paper-2"
    >
      <div
        contentEditable={false}
        className="cl-mono flex select-none items-center justify-between border-b border-rule bg-paper px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-ink-mute"
      >
        <span>Code</span>
        <div className="flex items-center gap-2.5">
          <CopyButton
            getText={() => code}
            label="Copy code"
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          />
          {lang === MERMAID_LANGUAGE && (
            // Pressed when the diagram is what's on screen — while the caret is
            // in the block that is never true, so the control always reads as
            // "show the diagram now".
            <MermaidViewToggle
              isDiagram={wantsDiagram}
              onChange={handleDiagramToggle}
            />
          )}
          {readOnly ? (
            <span className="cl-mono uppercase tracking-[0.18em] text-accent">
              {label}
            </span>
          ) : (
            <button
              type="button"
              ref={setTrigger}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setOpen((o) => !o)}
              aria-haspopup="listbox"
              aria-expanded={open}
              className="cl-mono cursor-pointer uppercase tracking-[0.18em] text-accent hover:text-accent-deep"
            >
              {label}
            </button>
          )}
        </div>
      </div>
      {wantsDiagram && (
        <ActivatableDiagram onActivate={readOnly ? undefined : editSource}>
          <MermaidDiagram state={state} />
        </ActivatableDiagram>
      )}
      {/* The source stays mounted even while the diagram is shown: Slate needs
          its text nodes in the document, and screen readers get the source in
          place of the (aria-hidden) picture. */}
      <pre
        className={cn(
          "cl-noscroll overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.5] text-ink",
          !showSource && "sr-only",
        )}
        spellCheck="false"
      >
        <code>{children}</code>
      </pre>
      {!readOnly && open && (
        <CodeLangPicker
          value={lang}
          reference={trigger}
          onSelect={handleSelect}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}

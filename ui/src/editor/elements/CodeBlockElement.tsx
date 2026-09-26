import { ChevronDown } from "lucide-react";
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
  MermaidExpandButton,
  MermaidViewToggle,
  useMermaidRender,
} from "#/components/MermaidDiagram";
import { CopyButton } from "#/components/ui/CopyButton";
import {
  CodeLangPicker,
  languageLabel,
} from "#/editor/elements/CodeLangPicker";
import { setCodeBlockLanguage } from "#/editor/elements/codeBlockLanguage";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
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
        className="absolute inset-0 cursor-text rounded-[12px] bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
  const label = languageLabel(lang);
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
      className="cl-codeblock group rounded-[12px] bg-sink px-2 pb-4 pt-1.5"
    >
      <div
        contentEditable={false}
        className="flex select-none items-center gap-1 text-[13px]"
      >
        {readOnly ? (
          <span className="flex h-7 items-center px-3 text-ink-2">{label}</span>
        ) : (
          <button
            type="button"
            ref={setTrigger}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => setOpen((o) => !o)}
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={`Code language: ${label}`}
            className={cn(
              "flex h-7 cursor-pointer items-center gap-1.5 rounded-full pl-3 pr-2.5 text-ink-2 transition-colors hover:bg-ground/60 hover:text-ink",
              FOCUS_RING_NATIVE,
            )}
          >
            {label}
            <ChevronDown aria-hidden size={11} strokeWidth={2} />
          </button>
        )}
        <span className="flex-1" />
        <CopyButton
          getText={() => code}
          label="Copy code"
          className="size-[30px] rounded-full hover:bg-ground/60 [&_svg]:size-[15px]"
        />
        {lang === MERMAID_LANGUAGE && (
          <>
            {/* Both controls stand down while the source is what's on
                screen: there is no picture to expand. */}
            <MermaidExpandButton
              svg={wantsDiagram && state.status === "ready" ? state.svg : null}
            />
            {/* Pressed when the diagram is what's on screen — while the
                caret is in the block that is never true, so the control
                always reads as "show the diagram now". */}
            <MermaidViewToggle
              isDiagram={wantsDiagram}
              onChange={handleDiagramToggle}
            />
          </>
        )}
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
          "cl-noscroll mt-1 overflow-x-auto px-3.5 text-[13px] leading-[1.65] text-ink-2",
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

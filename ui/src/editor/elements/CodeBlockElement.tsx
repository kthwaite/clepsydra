import { useState } from "react";
import {
  ReactEditor,
  type RenderElementProps,
  useSlateStatic,
} from "slate-react";
import { CopyButton } from "#/components/ui/CopyButton";
import { displayLabel } from "#/editor/code-languages";
import { CodeLangPicker } from "#/editor/elements/CodeLangPicker";
import { setCodeBlockLanguage } from "#/editor/elements/codeBlockLanguage";
import type { CodeBlockElement as CodeBlockElementType } from "#/editor/types";

type Props = RenderElementProps & { element: CodeBlockElementType };

export function CodeBlockElement({ attributes, children, element }: Props) {
  const editor = useSlateStatic();
  const [open, setOpen] = useState(false);
  // useState (not useRef) so CodeLangPicker re-renders with a non-null
  // reference once the trigger button mounts.
  const [trigger, setTrigger] = useState<HTMLButtonElement | null>(null);

  const lang = element.language ?? null;
  const label = lang ? displayLabel(lang) : "TXT";

  const handleSelect = (next: string | null) => {
    try {
      const path = ReactEditor.findPath(editor, element);
      setCodeBlockLanguage(editor, path, next);
    } catch {
      // The code block was removed before selection — nothing to update.
    }
    setOpen(false);
    ReactEditor.focus(editor);
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
            getText={() => element.children.map((c) => c.text).join("")}
            label="Copy code"
            className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
          />
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
        </div>
      </div>
      <pre
        className="cl-noscroll overflow-x-auto px-4 py-3 font-mono text-[12.5px] leading-[1.5] text-ink"
        spellCheck="false"
      >
        <code>{children}</code>
      </pre>
      {open && (
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

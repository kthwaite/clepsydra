import {
  type KeyboardEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  parseWikilinkDraft,
  type ParsedWikilinkDraft,
  type WikilinkCaretEdge,
  type WikilinkExit,
} from "#/editor/wikilinkEditing";

interface WikilinkInlineEditorProps {
  initialDraft: string;
  initialCaret: WikilinkCaretEdge;
  returnSide: "before" | "after";
  onCommit(parsed: ParsedWikilinkDraft, exit: WikilinkExit): void;
  onCancel(exit: WikilinkExit): void;
  onOpen(target: string): void;
}

export function WikilinkInlineEditor({
  initialDraft,
  initialCaret,
  returnSide,
  onCommit,
  onCancel,
  onOpen,
}: WikilinkInlineEditorProps) {
  const [draft, setDraft] = useState(initialDraft);
  const inputRef = useRef<HTMLInputElement>(null);
  const finishedRef = useRef(false);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.focus();
    const offset = initialCaret === "start" ? 0 : initialDraft.length;
    input.setSelectionRange(offset, offset);
  }, [initialCaret, initialDraft]);

  const finish = (exit: WikilinkExit) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const parsed = parseWikilinkDraft(draft);
    if (parsed) {
      onCommit(parsed, exit);
    } else {
      onCancel(exit);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (finishedRef.current) return;

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      const parsed = parseWikilinkDraft(draft);
      if (!parsed) return;

      finishedRef.current = true;
      onCommit(parsed, "after");
      onOpen(parsed.target);
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      finishedRef.current = true;
      onCancel(returnSide);
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      finish("after");
      return;
    }

    const input = event.currentTarget;
    if (
      event.key === "ArrowLeft" &&
      input.selectionStart === 0 &&
      input.selectionEnd === 0
    ) {
      event.preventDefault();
      finish("before");
      return;
    }

    if (
      event.key === "ArrowRight" &&
      input.selectionStart === draft.length &&
      input.selectionEnd === draft.length
    ) {
      event.preventDefault();
      finish("after");
    }
  };

  return (
    <span contentEditable={false}>
      <input
        ref={inputRef}
        aria-label="Edit wikilink"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        onBlur={() => finish("preserve")}
        className="min-w-[4ch] bg-transparent px-[2px] font-mono text-[0.95em] text-ink outline-none"
        style={{ width: `${Math.max(draft.length, 4)}ch` }}
      />
    </span>
  );
}

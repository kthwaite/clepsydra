import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { Element } from "slate";
import {
  type InlineSourceAdapter,
  type InlineSourceSession,
  type SourceCaretEdge,
  type SourceExit,
  type SourceParseResult,
  type SourceReturnSide,
  useInlineSourceEditing,
} from "#/editor/inlineSourceEditing";

interface InlineSourceInputProps {
  label: string;
  parse(draft: string): SourceParseResult;
  initialDraft: string;
  initialCaret: SourceCaretEdge;
  returnSide: SourceReturnSide;
  onCommit(draft: string, exit: SourceExit): void;
  onCancel(exit: SourceExit): void;
  /** Cmd/Ctrl-Enter: commit a valid draft, then open it. */
  onOpen?(draft: string): void;
}

/**
 * A plain-text input over an inline element's Markdown source.
 *
 * Enter commits and exits after. Esc cancels to the return side. ←/→ at an
 * edge commits and exits on that side. Blur commits in place. An `invalid`
 * draft is marked `aria-invalid`: Enter ignores it, and the other exits
 * cancel it.
 */
export function InlineSourceInput({
  label,
  parse,
  initialDraft,
  initialCaret,
  returnSide,
  onCommit,
  onCancel,
  onOpen,
}: InlineSourceInputProps) {
  const [draft, setDraft] = useState(initialDraft);
  const inputRef = useRef<HTMLInputElement>(null);
  const finishedRef = useRef(false);
  const invalid = parse(draft).kind === "invalid";

  // A passive effect, not a layout one: it runs after React has attached every
  // ref in the commit, including a remounted element root (a link swaps its
  // <a> for a <span>). Focusing earlier blurs the editor while Slate cannot yet
  // map the input's element, which throws in Slate's onBlur.
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    input.focus();
    const offset = initialCaret === "start" ? 0 : initialDraft.length;
    input.setSelectionRange(offset, offset);
  }, [initialCaret, initialDraft]);

  const finish = (exit: SourceExit) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (parse(draft).kind === "commit") {
      onCommit(draft, exit);
    } else {
      onCancel(exit);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (finishedRef.current) return;

    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (!onOpen || parse(draft).kind !== "commit") return;

      finishedRef.current = true;
      onCommit(draft, "after");
      onOpen(draft);
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
      if (invalid) return;
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
        aria-label={label}
        aria-invalid={invalid || undefined}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
        onBlur={() => finish("preserve")}
        spellCheck={false}
        className="min-w-[4ch] rounded-[3px] bg-accent-tint px-[2px] text-ink outline-none aria-invalid:text-hot"
        style={{ width: `${Math.max(draft.length, 4)}ch` }}
      />
    </span>
  );
}

interface InlineSourceEditorProps<E extends Element> {
  adapter: InlineSourceAdapter<E>;
  element: E;
  session: InlineSourceSession;
  onOpen?(draft: string): void;
}

/**
 * The active-session render of an inline element: the adapter's chrome
 * around an {@link InlineSourceInput}, wired to the editing controller.
 * The element keeps its own `attributes` span and Slate children around it.
 */
export function InlineSourceEditor<E extends Element>({
  adapter,
  element,
  session,
  onOpen,
}: InlineSourceEditorProps<E>): ReactNode {
  const controller = useInlineSourceEditing();
  return (
    <span contentEditable={false} className="align-baseline text-ink">
      {adapter.chrome && (
        <span aria-hidden className="text-mute">
          {adapter.chrome.open}
        </span>
      )}
      <InlineSourceInput
        label={adapter.label}
        parse={adapter.parse}
        initialDraft={adapter.toDraft(element)}
        initialCaret={session.initialCaret}
        returnSide={session.returnSide}
        onCommit={(draft, exit) => controller.commit(draft, exit)}
        onCancel={(exit) => controller.cancel(exit)}
        onOpen={onOpen}
      />
      {adapter.chrome && (
        <span aria-hidden className="text-mute">
          {adapter.chrome.close}
        </span>
      )}
    </span>
  );
}

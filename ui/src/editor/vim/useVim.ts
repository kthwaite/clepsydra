import { parseKeyboardEvent } from "@tanstack/hotkeys";
import { useCallback, useEffect, useRef, useState } from "react";
import { type Editor, Transforms } from "slate";
import type { VimMode } from "./core/ast";
import { tokenize } from "./core/keys";
import { createVimParser } from "./core/parser";
import { executeCommand } from "./slate/execute";
import { INITIAL_VIM_STATE, type VimState } from "./slate/types";

interface VimHandle {
  mode: VimMode;
  /** Keys collected toward an incomplete command ("2d", "f"), for display. */
  pending: string;
  /**
   * Feed a keydown. Returns true when vim consumed the event (the caller
   * must not run its own key handling); false lets the event fall through
   * to the host editor's shortcuts and to Slate itself.
   */
  handleKeyDown: (event: React.KeyboardEvent) => boolean;
  /** Blocks text-producing input (IME, autocorrect) outside insert mode. */
  handleDOMBeforeInput: (event: InputEvent) => boolean;
  /** Pointer interaction cancels pending input and visual mode. */
  handleMouseDown: () => void;
}

/**
 * Vim mode for a slate-react editor.
 *
 * Designed to sit inside the Editable's sanctioned interception points:
 * call `handleKeyDown` from the `onKeyDown` prop (after any UI that must
 * win, e.g. suggestion popovers) and pass `handleDOMBeforeInput` /
 * `handleMouseDown` to the corresponding Editable props.
 *
 * Key normalization runs through @tanstack/hotkeys' `parseKeyboardEvent`
 * for canonical modifier state; the raw `event.key` supplies the produced
 * character since vim distinguishes `a`/`A`/`$`.
 */
/**
 * Insert-mode escape sequence: typing "jk" quickly leaves insert mode.
 * The j types normally (blocking it would make ordinary typing laggy);
 * a k within the window deletes that j and escapes instead of typing.
 */
const ESCAPE_SEQUENCE = ["j", "k"] as const;
const ESCAPE_SEQUENCE_MS = 500;

export function useVim(editor: Editor, enabled: boolean): VimHandle {
  const parserRef = useRef(createVimParser());
  const [state, setState] = useState<VimState>(INITIAL_VIM_STATE);
  const [pending, setPending] = useState("");
  const stateRef = useRef(state);
  stateRef.current = state;
  const escapePrefixAtRef = useRef<number | null>(null);

  useEffect(() => {
    // Entering or leaving vim mode starts from a clean normal-mode slate.
    parserRef.current.reset();
    setState(INITIAL_VIM_STATE);
    setPending("");
  }, [enabled]);

  const runCommand = useCallback(
    (command: Parameters<typeof executeCommand>[2]) => {
      const patch = executeCommand(editor, stateRef.current, command);
      setState((prev) => ({ ...prev, ...patch }));
    },
    [editor],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent): boolean => {
      if (!enabled) return false;
      // Never fight IME composition; browsers also use Escape to cancel it.
      if (event.nativeEvent.isComposing || event.keyCode === 229) return false;

      const current = stateRef.current;
      const parser = parserRef.current;

      if (current.mode === "insert") {
        if (event.key === "Escape") {
          event.preventDefault();
          escapePrefixAtRef.current = null;
          parser.reset();
          setPending("");
          runCommand({ t: "escape" });
          return true;
        }
        const bare = !event.ctrlKey && !event.metaKey && !event.altKey;
        const prefixAt = escapePrefixAtRef.current;
        if (
          bare &&
          event.key === ESCAPE_SEQUENCE[1] &&
          prefixAt !== null &&
          performance.now() - prefixAt <= ESCAPE_SEQUENCE_MS
        ) {
          // Complete the jk escape: remove the j that already typed.
          event.preventDefault();
          escapePrefixAtRef.current = null;
          Transforms.delete(editor, {
            distance: 1,
            unit: "character",
            reverse: true,
          });
          parser.reset();
          setPending("");
          runCommand({ t: "escape" });
          return true;
        }
        escapePrefixAtRef.current =
          bare && event.key === ESCAPE_SEQUENCE[0] ? performance.now() : null;
        return false;
      }

      const parsed = parseKeyboardEvent(event.nativeEvent);
      const key = tokenize({
        key: event.key,
        ctrlKey: parsed.ctrl,
        metaKey: parsed.meta,
        altKey: parsed.alt,
      });
      if (key === null) return false;

      // Consume every vim-relevant key in normal/visual mode — even ones
      // the grammar ignores — so stray printables never type text.
      event.preventDefault();
      const result = parser.feed(
        key,
        current.mode === "visual" ? "visual" : "normal",
      );
      if (result.kind === "command") {
        runCommand(result.command);
      }
      setPending(parser.pending);
      return true;
    },
    [enabled, runCommand],
  );

  const handleDOMBeforeInput = useCallback(
    (event: InputEvent): boolean => {
      if (!enabled || stateRef.current.mode === "insert") return false;
      event.preventDefault();
      return true;
    },
    [enabled],
  );

  const handleMouseDown = useCallback(() => {
    if (!enabled) return;
    escapePrefixAtRef.current = null;
    parserRef.current.reset();
    setPending("");
    setState((prev) =>
      prev.mode === "visual"
        ? {
            ...prev,
            mode: "normal",
            visualAnchor: null,
            visualHead: null,
            visualKind: "char",
          }
        : prev,
    );
  }, [enabled]);

  return {
    mode: state.mode,
    pending,
    handleKeyDown,
    handleDOMBeforeInput,
    handleMouseDown,
  };
}

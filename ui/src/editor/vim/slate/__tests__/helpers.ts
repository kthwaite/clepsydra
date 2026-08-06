import type { Editor } from "slate";
import { createVimParser } from "../../core/parser";
import { executeCommand } from "../execute";
import { INITIAL_VIM_STATE, type VimState } from "../types";

/** Split "2dd<Esc>x" into vim keys: single chars plus <...> tokens. */
function splitKeys(input: string): string[] {
  return input.match(/<[^>]+>|./gs) ?? [];
}

/**
 * Feed a key sequence through the real parser and executor, threading state
 * exactly like the React layer does. Returns the final VimState.
 */
export function keys(
  editor: Editor,
  input: string,
  initial: VimState = INITIAL_VIM_STATE,
): VimState {
  const parser = createVimParser();
  let state = initial;
  for (const key of splitKeys(input)) {
    if (state.mode === "insert") {
      // Mirror the React layer: insert mode only intercepts Escape.
      if (key !== "<Esc>") {
        throw new Error(
          `test fed "${key}" while in insert mode; end the sequence earlier`,
        );
      }
      state = {
        ...state,
        ...executeCommand(editor, state, { t: "escape" }),
      };
      continue;
    }
    const result = parser.feed(
      key,
      state.mode === "visual" ? "visual" : "normal",
    );
    if (result.kind === "command") {
      state = { ...state, ...executeCommand(editor, state, result.command) };
    }
  }
  return state;
}

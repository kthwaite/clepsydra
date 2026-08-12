import { ReactEditor, useReadOnly, useSlateStatic } from "slate-react";
import {
  type ConversationMarker,
  type ConversationRole,
  formatConversationMarker,
} from "../../conversation/marker";
import { useConversationPresentation } from "../../conversation/presentation";
import {
  insertConversationTurn,
  moveConversationTurn,
  removeConversationTurn,
  setConversationRole,
} from "../../conversation/transforms";
import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { ConversationTurnElement } from "../types";

function assistantDisplayLabel(provider: string | null): string {
  const normalized = provider?.trim();
  if (!normalized) return "Assistant";
  const knownProvider = normalized.toLowerCase();
  if (knownProvider === "claude") return "Claude";
  if (knownProvider === "chatgpt") return "ChatGPT";
  return normalized
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(
      (token) =>
        `${token.charAt(0).toUpperCase()}${token.slice(1).toLowerCase()}`,
    )
    .join(" ");
}

function ConversationTurn({
  attributes,
  children,
  element,
}: Parameters<ElementDescriptor<ConversationTurnElement>["render"]>[0]) {
  const editor = useSlateStatic();
  const presentation = useConversationPresentation();
  const readOnly = useReadOnly();
  if (presentation.mode === "generic") {
    const marker: ConversationMarker = {
      role: element.role,
      source: element.source,
      sequence:
        element.origin === "source" ? (element.sourceSequence ?? 1) : null,
      timestamp:
        element.origin === "source" ? (element.timestamp ?? null) : null,
      origin: element.origin,
    };
    return (
      <blockquote
        {...attributes}
        className="my-4 border-l-2 border-accent bg-paper-2 py-2 pl-4 pr-3 text-[0.97em] italic text-ink-2"
      >
        <span
          contentEditable={false}
          className="cl-mono mb-2 block text-[0.8em] not-italic text-ink-mute"
        >
          {formatConversationMarker(marker)}
        </span>
        {children}
      </blockquote>
    );
  }

  const assistantLabel = assistantDisplayLabel(presentation.provider);
  const participantLabel = element.role === "user" ? "You" : assistantLabel;

  return (
    <article
      {...attributes}
      className="ai-conversation-turn"
      data-role={element.role}
    >
      <aside
        contentEditable={false}
        className="ai-conversation-turn__participant"
      >
        {presentation.mode === "read" || readOnly ? (
          participantLabel
        ) : (
          <>
            <select
              aria-label="Change participant"
              value={element.role}
              onChange={(event) =>
                setConversationRole(
                  editor,
                  ReactEditor.findPath(editor, element),
                  event.currentTarget.value as ConversationRole,
                )
              }
            >
              <option value="user">You</option>
              <option value="assistant">{assistantLabel}</option>
            </select>
            <div className="ai-conversation-turn__actions">
              <button
                type="button"
                aria-label="Move turn up"
                onClick={() =>
                  moveConversationTurn(
                    editor,
                    ReactEditor.findPath(editor, element),
                    -1,
                  )
                }
              >
                ↑
              </button>
              <button
                type="button"
                aria-label="Move turn down"
                onClick={() =>
                  moveConversationTurn(
                    editor,
                    ReactEditor.findPath(editor, element),
                    1,
                  )
                }
              >
                ↓
              </button>
              <button
                type="button"
                aria-label="Add turn after"
                onClick={() =>
                  insertConversationTurn(editor, {
                    after: ReactEditor.findPath(editor, element),
                  })
                }
              >
                +
              </button>
              <button
                type="button"
                aria-label="Remove turn"
                onClick={() =>
                  removeConversationTurn(
                    editor,
                    ReactEditor.findPath(editor, element),
                  )
                }
              >
                ×
              </button>
            </div>
          </>
        )}
      </aside>
      <div className="ai-conversation-turn__content">{children}</div>
    </article>
  );
}
export const conversationTurnDescriptor: ElementDescriptor<ConversationTurnElement> =
  {
    type: "conversation-turn",
    kind: "block",
    create: ({
      children = [{ type: "paragraph", children: [{ text: "" }] }],
      ...rest
    }: CreateProps<ConversationTurnElement>) => ({
      type: "conversation-turn",
      children,
      ...rest,
    }),
    render: ConversationTurn,
    toMdast: (node, ctx) => {
      const marker: ConversationMarker = {
        role: node.role,
        source: node.source,
        sequence: node.origin === "source" ? (node.sourceSequence ?? 1) : null,
        timestamp: node.origin === "source" ? (node.timestamp ?? null) : null,
        origin: node.origin,
      };
      return {
        type: "blockquote",
        children: [
          {
            type: "paragraph",
            children: [
              { type: "html", value: formatConversationMarker(marker) },
            ],
          },
          ...ctx.blockChildren(node.children),
        ],
      };
    },
  };

export const makeConversationTurn = conversationTurnDescriptor.create;

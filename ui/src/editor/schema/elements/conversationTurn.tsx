import { ReactEditor, useReadOnly, useSlateStatic } from "slate-react";
import { Tick } from "#/components/codex/Tick";
import { Select, SelectItem } from "#/components/ui/select";
import { cn } from "#/lib/cn";
import { FOCUS_RING_NATIVE } from "#/lib/focusRing";
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

const TURN_ACTION = cn(
  "inline-flex size-7 cursor-pointer items-center justify-center rounded-full text-[14px] text-mute transition-colors hover:bg-sink hover:text-ink",
  FOCUS_RING_NATIVE,
);

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
        className="my-4 rounded-[12px] bg-sink px-5 py-4 text-ink-2"
      >
        <span
          contentEditable={false}
          className="mb-2 block text-[12.5px] text-mute"
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
      // An editorial speaker gutter, not chat bubbles: turns part by space.
      className={cn(
        "grid grid-cols-[7.5rem_minmax(0,1fr)] items-start gap-6 py-3 max-md:grid-cols-1 max-md:gap-2",
        presentation.mode === "read" && "py-4",
      )}
      data-role={element.role}
    >
      <aside
        contentEditable={false}
        className="flex min-w-0 flex-col gap-2 pt-1 text-[13px] text-mute"
      >
        {presentation.mode === "read" || readOnly ? (
          <span className="flex items-center gap-2.5">
            <Tick variant={element.role === "user" ? "faint" : "live"} />
            {participantLabel}
          </span>
        ) : (
          <>
            <Select
              aria-label="Change participant"
              className="[&>button]:h-8 [&>button]:px-3 [&>button]:text-[13px]"
              value={element.role}
              onChange={(key) => {
                if (key === null) return;
                setConversationRole(
                  editor,
                  ReactEditor.findPath(editor, element),
                  String(key) as ConversationRole,
                );
              }}
            >
              <SelectItem id="user">You</SelectItem>
              <SelectItem id="assistant" textValue={assistantLabel}>
                {assistantLabel}
              </SelectItem>
            </Select>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                className={TURN_ACTION}
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
                className={TURN_ACTION}
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
                className={TURN_ACTION}
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
                className={TURN_ACTION}
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
      <div className="min-w-0">{children}</div>
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

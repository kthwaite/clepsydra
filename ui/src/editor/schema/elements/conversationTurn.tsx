import type { CreateProps, ElementDescriptor } from "../descriptor";
import type { ConversationTurnElement } from "../types";
import {
  formatConversationMarker,
  type ConversationMarker,
} from "../../conversation/marker";

export const conversationTurnDescriptor: ElementDescriptor<ConversationTurnElement> = {
  type: "conversation-turn",
  kind: "block",
  create: ({ children = [{ type: "paragraph", children: [{ text: "" }] }], ...rest }: CreateProps<ConversationTurnElement>) => ({
    type: "conversation-turn",
    children,
    ...rest,
  }),
  render: ({ attributes, children, element }) => (
    <article
      {...attributes}
      className="ai-conversation-turn"
      data-role={element.role}
    >
      <aside contentEditable={false} className="ai-conversation-turn__participant">
        {element.role === "user" ? "You" : "Assistant"}
      </aside>
      <div className="ai-conversation-turn__content">{children}</div>
    </article>
  ),
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
          children: [{ type: "html", value: formatConversationMarker(marker) }],
        },
        ...ctx.blockChildren(node.children),
      ],
    };
  },
};

export const makeConversationTurn = conversationTurnDescriptor.create;

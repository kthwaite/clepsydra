import { describe, expect, it } from "vitest";
import type { ConversationTurnElement } from "../../schema/types";
import { markdownToSlate, slateToMarkdown } from "../index";

const HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

const richConversation = `> [!AI-ASSISTANT source=sha256:${HASH} sequence=2 timestamp=2026-08-09T09:14:00Z]
>
> First paragraph with **bold** and [[Project|alias]].
>
> ## Nested heading
>
> - outer
>   - inner
>
> \`\`\`ts
> const answer = 42;
> \`\`\`
>
> $$
> x^2
> $$
>
> [ordinary link](https://example.com)

> This is an ordinary blockquote.
`;

describe("conversation markdown/Slate conversion", () => {
  it("recognizes only canonical AI callout blockquotes", () => {
    const [turn, quote] = markdownToSlate(richConversation);
    expect(turn).toMatchObject({
      type: "conversation-turn",
      role: "assistant",
      source: `sha256:${HASH}`,
      sourceSequence: 2,
      timestamp: "2026-08-09T09:14:00Z",
      origin: "source",
    });
    expect(quote).toMatchObject({ type: "blockquote" });
    const turnElement = turn as ConversationTurnElement;
    expect(turnElement.children).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "heading", level: 2 }),
        expect.objectContaining({ type: "bulleted-list" }),
        expect.objectContaining({ type: "code-block", language: "ts" }),
        expect.objectContaining({ type: "math-block" }),
      ]),
    );
  });

  it("keeps malformed marker blockquotes generic", () => {
    const markdown = `> [!AI-ASSISTANT source=sha256:not-a-hash sequence=2]\n> body`;
    const result = markdownToSlate(markdown);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ type: "blockquote" });
    expect(JSON.stringify(result[0])).toContain(
      "[!AI-ASSISTANT source=sha256:not-a-hash sequence=2]",
    );
    expect(JSON.stringify(result[0])).toContain("body");
  });

  it("supplies a valid empty paragraph for an empty turn", () => {
    const markdown = `> [!AI-USER source=sha256:${HASH} sequence=1]`;
    expect(markdownToSlate(markdown)).toEqual([
      expect.objectContaining({
        type: "conversation-turn",
        children: [{ type: "paragraph", children: [{ text: "" }] }],
      }),
    ]);
  });

  it("recognizes capture output with marker and first body line in one paragraph", () => {
    const markdown = `> [!AI-USER source=sha256:${HASH} sequence=1]\n> Captured body`;
    expect(markdownToSlate(markdown)).toEqual([
      expect.objectContaining({
        type: "conversation-turn",
        children: [{ type: "paragraph", children: [{ text: "Captured body" }] }],
      }),
    ]);
  });

  it("retains formatting when capture marker shares a paragraph with body", () => {
    const markdown = `> [!AI-USER source=sha256:${HASH} sequence=1]\n> **bold** and [link](https://example.com)`;
    const [turn] = markdownToSlate(markdown);
    expect(turn).toMatchObject({
      type: "conversation-turn",
      children: [
        {
          type: "paragraph",
          children: [
            { text: "bold", bold: true },
            { text: " and " },
            {
              type: "link",
              url: "https://example.com",
              children: [{ text: "link" }],
            },
          ],
        },
      ],
    });
  });


  it("preserves a leading greater-than in top-level display math", () => {
    expect(markdownToSlate("$$\n> x\n$$")).toEqual([
      expect.objectContaining({ type: "math-block", tex: "\n> x\n" }),
    ]);
  });

  it("round-trips a conversation and ordinary quote without content loss", () => {
    const slate = markdownToSlate(richConversation);
    const serialized = slateToMarkdown(slate);
    expect(markdownToSlate(serialized)).toEqual(slate);
    expect(serialized).toContain(
      `> [!AI-ASSISTANT source=sha256:${HASH} sequence=2 timestamp=2026-08-09T09:14:00Z`,
    );
    expect(serialized).toContain("> This is an ordinary blockquote.");
  });

  it("serializes local API-created turns using a canonical marker", () => {
    const slate = [
      {
        type: "conversation-turn" as const,
        role: "user" as const,
        source: "local:123e4567-e89b-12d3-a456-426614174000",
        origin: "local" as const,
        children: [{ type: "paragraph" as const, children: [{ text: "Hi" }] }],
      },
    ];
    expect(slateToMarkdown(slate)).toBe(
      "> [!AI-USER source=local:123e4567-e89b-12d3-a456-426614174000]\n>\n> Hi\n",
    );
  });
});

import {
  createEditor,
  type Descendant,
  type Editor,
  Element as SlateElement,
} from "slate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationTurnElement } from "../schema/types";
import {
  insertConversationTurn,
  moveConversationTurn,
  removeConversationTurn,
  setConversationRole,
} from "./transforms";

const HASH_A = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const HASH_B = "123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef0";
const HASH_C = "23456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef01";

function turn(
  source: string,
  role: ConversationTurnElement["role"],
  sourceSequence: number,
): ConversationTurnElement {
  return {
    type: "conversation-turn",
    role,
    source: `sha256:${source}`,
    sourceSequence,
    timestamp: `2026-08-09T10:0${sourceSequence}:00Z`,
    origin: "source",
    children: [
      {
        type: "paragraph",
        children: [
          { text: `turn-${sourceSequence} ` },
          {
            type: "link",
            url: `https://example.com/${sourceSequence}`,
            children: [{ text: "nested" }],
          },
        ],
      },
    ],
  };
}

function editorWith(children: Descendant[]): Editor {
  const editor = createEditor();
  editor.children = children;
  return editor;
}

function conversationTurns(editor: Editor): ConversationTurnElement[] {
  return editor.children.filter(
    (node): node is ConversationTurnElement =>
      SlateElement.isElement(node) && node.type === "conversation-turn",
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("conversation transforms", () => {
  it("inserts a local assistant turn after the requested turn with a deterministic UUID", () => {
    const first = turn(HASH_A, "user", 1);
    const last = turn(HASH_B, "assistant", 2);
    const editor = editorWith([first, last]);
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-2222-4333-8444-555555555555",
    );

    insertConversationTurn(editor, { after: [0] });

    expect(editor.children).toHaveLength(3);
    expect(editor.children[0]).toBe(first);
    expect(editor.children[2]).toBe(last);
    expect(editor.children[1]).toEqual({
      type: "conversation-turn",
      role: "assistant",
      source: "local:11111111-2222-4333-8444-555555555555",
      origin: "local",
      children: [{ type: "paragraph", children: [{ text: "" }] }],
    });
    expect(editor.children[1]).not.toHaveProperty("sourceSequence");
    expect(editor.children[1]).not.toHaveProperty("timestamp");
  });

  it("accepts an injected UUID factory and appends when no boundary is supplied", () => {
    const first = turn(HASH_A, "user", 1);
    const editor = editorWith([first]);

    insertConversationTurn(editor, {
      role: "user",
      uuidFactory: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });

    expect(editor.children[1]).toMatchObject({
      role: "user",
      source: "local:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      origin: "local",
    });
    expect(editor.children[0]).toBe(first);
  });

  it("ignores a malformed insertion boundary without changing or losing content", () => {
    const first = turn(HASH_A, "user", 1);
    const fallback = {
      type: "blockquote" as const,
      children: [{ type: "paragraph" as const, children: [{ text: "raw" }] }],
    };
    const editor = editorWith([first, fallback]);
    const before = [...editor.children];

    insertConversationTurn(editor, { after: [1, 0] });

    expect(editor.children).toEqual(before);
    expect(editor.children[0]).toBe(first);
    expect(editor.children[1]).toBe(fallback);
  });

  it("corrects only the participant role and preserves source metadata and nested children", () => {
    const first = turn(HASH_A, "assistant", 1);
    const nestedChildren = first.children;
    const nestedParagraph = first.children[0];
    const editor = editorWith([first]);

    setConversationRole(editor, [0], "user");

    const corrected = conversationTurns(editor)[0];
    expect(corrected).toEqual({ ...first, role: "user" });
    expect(corrected.source).toBe(first.source);
    expect(corrected.sourceSequence).toBe(first.sourceSequence);
    expect(corrected.timestamp).toBe(first.timestamp);
    expect(corrected.origin).toBe(first.origin);
    expect(corrected.children).toBe(nestedChildren);
    expect(corrected.children[0]).toBe(nestedParagraph);
  });

  it("does not correct fallback or nested nodes at malformed boundaries", () => {
    const fallback = {
      type: "blockquote" as const,
      children: [{ type: "paragraph" as const, children: [{ text: "raw" }] }],
    };
    const first = turn(HASH_A, "assistant", 1);
    const editor = editorWith([fallback, first]);
    const before = [...editor.children];

    setConversationRole(editor, [0], "user");
    setConversationRole(editor, [1, 0], "user");

    expect(editor.children).toEqual(before);
    expect(editor.children[0]).toBe(fallback);
    expect(editor.children[1]).toBe(first);
  });

  it("moves among conversation siblings while fallback nodes remain at their positions", () => {
    const first = turn(HASH_A, "user", 1);
    const fallback = {
      type: "blockquote" as const,
      children: [{ type: "paragraph" as const, children: [{ text: "raw" }] }],
    };
    const second = turn(HASH_B, "assistant", 2);
    const third = turn(HASH_C, "user", 3);
    const firstChildren = first.children;
    const secondChildren = second.children;
    const editor = editorWith([first, fallback, second, third]);

    moveConversationTurn(editor, [0], 1);

    expect(editor.children).toEqual([second, fallback, first, third]);
    expect(editor.children[1]).toBe(fallback);
    expect((editor.children[0] as ConversationTurnElement).children).toBe(
      secondChildren,
    );
    expect((editor.children[2] as ConversationTurnElement).children).toBe(
      firstChildren,
    );
    expect(conversationTurns(editor).map(({ source }) => source)).toEqual([
      second.source,
      first.source,
      third.source,
    ]);
  });

  it("respects conversation boundaries and malformed move paths", () => {
    const first = turn(HASH_A, "user", 1);
    const fallback = {
      type: "paragraph" as const,
      children: [{ text: "fallback" }],
    };
    const second = turn(HASH_B, "assistant", 2);
    const editor = editorWith([first, fallback, second]);
    const before = [...editor.children];

    moveConversationTurn(editor, [0], -1);
    moveConversationTurn(editor, [2], 1);
    moveConversationTurn(editor, [1], 1);
    moveConversationTurn(editor, [0, 0], 1);

    expect(editor.children).toEqual(before);
    expect(editor.children[0]).toBe(first);
    expect(editor.children[1]).toBe(fallback);
    expect(editor.children[2]).toBe(second);
  });

  it("removes a turn without changing surviving identities or nested content", () => {
    const first = turn(HASH_A, "user", 1);
    const second = turn(HASH_B, "assistant", 2);
    const secondChildren = second.children;
    const editor = editorWith([first, second]);

    removeConversationTurn(editor, [0]);

    expect(editor.children).toEqual([second]);
    expect(editor.children[0]).toBe(second);
    expect((editor.children[0] as ConversationTurnElement).children).toBe(
      secondChildren,
    );
  });

  it("leaves one empty paragraph after removing the document's only turn", () => {
    const editor = editorWith([turn(HASH_A, "user", 1)]);

    removeConversationTurn(editor, [0]);

    expect(editor.children).toEqual([
      { type: "paragraph", children: [{ text: "" }] },
    ]);
  });

  it("does not remove fallback or nested content at malformed boundaries", () => {
    const fallback = {
      type: "blockquote" as const,
      children: [{ type: "paragraph" as const, children: [{ text: "raw" }] }],
    };
    const first = turn(HASH_A, "user", 1);
    const editor = editorWith([fallback, first]);
    const before = [...editor.children];

    removeConversationTurn(editor, [0]);
    removeConversationTurn(editor, [1, 0]);

    expect(editor.children).toEqual(before);
    expect(editor.children[0]).toBe(fallback);
    expect(editor.children[1]).toBe(first);
  });
});

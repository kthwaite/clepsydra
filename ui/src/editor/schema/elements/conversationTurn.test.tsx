import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { createEditor, type Descendant, Transforms } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { SlateEditor } from "#/editor/SlateEditor";
import {
  ConversationPresentationProvider,
  type ConversationPresentation,
} from "#/editor/conversation/presentation";
import { renderElement } from "#/editor/elements/renderElement";
import type {
  ConversationTurnElement,
  CustomEditor,
} from "#/editor/schema/types";
import { withSchema } from "#/editor/schema/withSchema";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function turn(
  sequence: number,
  role: ConversationTurnElement["role"] = sequence % 2 ? "user" : "assistant",
): ConversationTurnElement {
  return {
    type: "conversation-turn",
    role,
    source: `sha256:${String(sequence).repeat(64)}`,
    sourceSequence: sequence,
    timestamp: `2026-08-09T10:0${sequence}:00Z`,
    origin: "source",
    children: [
      {
        type: "paragraph",
        children: [{ text: `turn ${sequence}` }],
      },
    ],
  };
}

function renderConversation(
  presentation: ConversationPresentation,
  value: Descendant[] = [turn(1)],
) {
  const editor = withReact(withSchema(createEditor()));
  render(
    <ConversationPresentationProvider value={presentation}>
      <Slate editor={editor} initialValue={value}>
        <Editable renderElement={renderElement} />
      </Slate>
    </ConversationPresentationProvider>,
  );
  return editor;
}

function articleFor(text: string) {
  const content = screen.getByText(text);
  const article = content.closest("article");
  if (!article) throw new Error(`No conversation article contains ${text}`);
  return article;
}

describe("conversation turn presentation", () => {
  it("renders Claude metadata in Read mode without edit controls", () => {
    renderConversation({ mode: "read", provider: "claude" }, [
      turn(1, "assistant"),
    ]);

    const label = screen.getByText("Claude");
    expect(label.closest("aside")).toHaveAttribute("contenteditable", "false");
    expect(screen.queryByRole("combobox", { name: "Change participant" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move turn up" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Move turn down" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Add turn after" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remove turn" })).toBeNull();
  });

  it("uses Assistant without a provider", () => {
    renderConversation({ mode: "read", provider: null }, [
      turn(1, "assistant"),
    ]);

    expect(screen.getByText("Assistant")).toBeInTheDocument();
  });

  it("normalizes the known ChatGPT provider label", () => {
    renderConversation({ mode: "read", provider: "CHATGPT" }, [
      turn(2, "assistant"),
    ]);

    expect(screen.getByText("ChatGPT")).toBeInTheDocument();
  });

  it("title-cases an unknown provider without changing stored metadata", () => {
    const unknown = turn(2, "assistant");
    const editor = renderConversation(
      { mode: "read", provider: "open_source-agent" },
      [unknown],
    );

    expect(screen.getByText("Open Source Agent")).toBeInTheDocument();
    expect(editor.children[0]).toBe(unknown);
    expect(editor.children[0]).toMatchObject({
      role: "assistant",
      source: unknown.source,
      sourceSequence: unknown.sourceSequence,
      timestamp: unknown.timestamp,
    });
  });

  it("always labels the user participant You", () => {
    renderConversation({ mode: "read", provider: "chatgpt" }, [turn(1, "user")]);

    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.queryByText("ChatGPT")).toBeNull();
  });

  it("defaults to editable presentation when no provider is mounted", () => {
    const editor = withReact(withSchema(createEditor()));
    render(
      <Slate editor={editor} initialValue={[turn(1)]}>
        <Editable renderElement={renderElement} />
      </Slate>,
    );

    expect(
      screen.getByRole("combobox", { name: "Change participant" }),
    ).toBeInTheDocument();
  });

  it("shows semantic edit controls and participant correction changes only the role", async () => {
    const user = userEvent.setup();
    const original = turn(2, "assistant");
    const nestedChildren = original.children;
    const editor = renderConversation({ mode: "edit", provider: "chatgpt" }, [
      original,
    ]);

    const select = screen.getByRole("combobox", { name: "Change participant" });
    expect(select).toHaveValue("assistant");
    expect(screen.getByRole("button", { name: "Move turn up" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move turn down" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add turn after" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove turn" })).toBeInTheDocument();
    expect(select.closest("aside")).toHaveAttribute("contenteditable", "false");

    await user.selectOptions(select, "user");

    const corrected = editor.children[0] as ConversationTurnElement;
    expect(corrected).toEqual({ ...original, role: "user" });
    expect(corrected.children).toBe(nestedChildren);
  });

  it("wires add, move, and remove controls to the conversation transforms", async () => {
    const user = userEvent.setup();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "11111111-2222-4333-8444-555555555555",
    );
    const first = turn(1, "user");
    const second = turn(2, "assistant");
    const editor = renderConversation({ mode: "edit", provider: null }, [
      first,
      second,
    ]);

    await user.click(
      within(articleFor("turn 1")).getByRole("button", {
        name: "Add turn after",
      }),
    );
    expect(editor.children).toHaveLength(3);
    expect(editor.children[1]).toMatchObject({
      source: "local:11111111-2222-4333-8444-555555555555",
      origin: "local",
      role: "assistant",
    });

    await user.click(
      within(articleFor("turn 1")).getByRole("button", {
        name: "Move turn down",
      }),
    );
    expect(editor.children[0]).toMatchObject({
      source: "local:11111111-2222-4333-8444-555555555555",
    });
    expect(editor.children[1]).toBe(first);

    await user.click(
      within(articleFor("turn 1")).getByRole("button", {
        name: "Remove turn",
      }),
    );
    expect(editor.children).toHaveLength(2);
    expect(editor.children).not.toContain(first);
    expect(editor.children).toContain(second);
  });
});

describe("SlateEditor read-only contract", () => {
  it("exposes and clears the editor ref while read-only selection stays non-dirty", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, enabled: false } },
    });
    const onChange = vi.fn();
    const onSaveNow = vi.fn();
    const editorRef = { current: null as CustomEditor | null };
    const { container, unmount } = render(
      <QueryClientProvider client={client}>
        <SlateEditor
          initialValue={[{ type: "paragraph", children: [{ text: "copy me" }] }]}
          onChange={onChange}
          onSaveNow={onSaveNow}
          readOnly
          editorRef={editorRef}
        />
      </QueryClientProvider>,
    );

    const editor = editorRef.current;
    if (!editor) throw new Error("Expected SlateEditor to assign editorRef");
    const editable = container.querySelector<HTMLElement>(
      "[data-slate-editor=true]",
    );
    if (!editable) throw new Error("Expected a Slate editable");
    expect(editable).toHaveAttribute("contenteditable", "false");

    act(() => {
      Transforms.select(editor, {
        anchor: { path: [0, 0], offset: 0 },
        focus: { path: [0, 0], offset: 4 },
      });
    });
    await waitFor(() => expect(editor.selection).not.toBeNull());
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(editable, { key: "V", ctrlKey: true, shiftKey: true });
    fireEvent.keyDown(editable, { key: "s", metaKey: true });
    expect(screen.queryByText("NORMAL")).toBeNull();
    expect(onSaveNow).not.toHaveBeenCalled();

    unmount();
    expect(editorRef.current).toBeNull();
  });
});

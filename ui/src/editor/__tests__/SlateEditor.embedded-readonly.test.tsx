import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Descendant } from "slate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BlocksApi from "#/api/blocks";
import type { BlockResponse } from "#/api/blocks";
import { markdownToSlate } from "#/editor/convert";
import type { CustomEditor } from "#/editor/types";

const {
  lookupMock,
  openTabMock,
  resolveOrCreateMock,
  useBlockMock,
} = vi.hoisted(() => ({
  lookupMock: vi.fn(),
  openTabMock: vi.fn(),
  resolveOrCreateMock: vi.fn(),
  useBlockMock: vi.fn(),
}));

vi.mock("#/editor/wikilinkResolution", () => ({
  useWikilinkResolution: () => ({ lookup: lookupMock }),
}));

vi.mock("#/editor/useResolveOrCreateWikilinkTarget", () => ({
  useResolveOrCreateWikilinkTarget: () => ({
    resolveOrCreate: resolveOrCreateMock,
  }),
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

vi.mock("#/api/blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof BlocksApi>();
  return { ...actual, useBlock: useBlockMock };
});

import { SlateEditor } from "#/editor/SlateEditor";

const REFERENCED_BLOCK: BlockResponse = {
  block_id: "abc123DEF0",
  block_type: "listitem",
  content: "Referenced sentence",
  page_path: "notes/source.md",
  page_title: "Source",
  span_start: 10,
  span_end: 50,
  properties: {},
};

const INITIAL_VALUE: Descendant[] = [
  {
    type: "paragraph",
    children: [
      { text: "" },
      {
        type: "wikilink",
        target: "Existing",
        children: [{ text: "" }],
      },
      { text: " " },
      {
        type: "wikilink",
        target: "Dangling",
        children: [{ text: "" }],
      },
      { text: " " },
      {
        type: "inline-math",
        tex: "x^2",
        delimiter: "$",
        children: [{ text: "" }],
      },
      { text: " " },
      {
        type: "block-ref",
        blockId: "abc123DEF0",
        children: [{ text: "" }],
      },
      { text: "" },
    ],
  },
  {
    type: "code-block",
    language: "rust",
    children: [{ text: "fn main() {}" }],
  },
] as Descendant[];

function testQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lookupMock.mockImplementation((target: string) =>
    target === "Existing" ? "notes/existing.md" : null,
  );
  resolveOrCreateMock.mockResolvedValue({
    path: "notes/dangling.md",
    title: "Dangling",
  });
  useBlockMock.mockReturnValue({
    data: REFERENCED_BLOCK,
    error: null,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
});

describe("SlateEditor embedded read-only contract", () => {
  it("retains navigation and copy without editor callbacks, creation, or tree mutation", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSaveNow = vi.fn();
    const editorRef = { current: null as CustomEditor | null };
    const writeText = vi.spyOn(navigator.clipboard, "writeText");

    render(
      <QueryClientProvider client={testQueryClient()}>
        <SlateEditor
          initialValue={INITIAL_VALUE}
          onChange={onChange}
          onSaveNow={onSaveNow}
          readOnly
          editorRef={editorRef}
        />
      </QueryClientProvider>,
    );

    const editor = editorRef.current;
    if (!editor) throw new Error("Expected SlateEditor to assign editorRef");
    const before = JSON.parse(JSON.stringify(editor.children));

    fireEvent.click(screen.getByRole("link", { name: /Existing/ }));
    expect(openTabMock).toHaveBeenCalledWith("page", "notes/existing.md");

    const dangling = screen.getByRole("link", { name: /Dangling/ });
    fireEvent.click(dangling);
    fireEvent.click(dangling, { metaKey: true });
    expect(resolveOrCreateMock).not.toHaveBeenCalled();

    const math = screen.getByTestId("inline-math");
    fireEvent.click(math);
    fireEvent.keyDown(math, { key: "Enter" });
    expect(
      screen.queryByRole("textbox", { name: "Edit inline math" }),
    ).toBeNull();

    expect(screen.getByText("Referenced sentence")).toBeVisible();
    const source = screen.getByRole("button", {
      name: "Open referenced block in Source",
    });
    expect(source).toHaveAttribute("contenteditable", "false");
    await user.click(source);
    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/source.md",
      "Source",
      { blockId: "abc123DEF0" },
    );

    expect(screen.queryByRole("button", { name: "RUST" })).toBeNull();
    expect(screen.queryByPlaceholderText("Search language…")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("fn main() {}"),
    );

    expect(editor.children).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
    expect(onSaveNow).not.toHaveBeenCalled();
  });

  it("renders linked block-reference text as one ordinary link without a nested transclusion", () => {
    const initialValue = markdownToSlate(
      "[**See ((abc123DEF0))**](https://example.com)",
    );

    render(
      <QueryClientProvider client={testQueryClient()}>
        <SlateEditor
          initialValue={initialValue}
          onChange={vi.fn()}
          onSaveNow={vi.fn()}
          readOnly
        />
      </QueryClientProvider>,
    );

    expect(
      screen.getByRole("link", { name: "See ((abc123DEF0))" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "Open referenced block in Source",
      }),
    ).toBeNull();
    expect(useBlockMock).not.toHaveBeenCalled();
  });
});

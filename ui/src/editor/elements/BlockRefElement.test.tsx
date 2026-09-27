import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createEditor, type Descendant } from "slate";
import {
  Editable,
  type RenderElementProps,
  Slate,
  withReact,
} from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BlocksApi from "#/api/blocks";
import type { BlockResponse } from "#/api/blocks";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { BlockRefElement } from "#/editor/elements/BlockRefElement";
import { INLINE_SOURCE_ADAPTERS } from "#/editor/inlineSourceAdapters";
import {
  InlineSourceEditingProvider,
  useInlineSourceEditingController,
} from "#/editor/inlineSourceEditing";
import { withSchema } from "#/editor/schema/withSchema";
import type { BlockRefElement as BlockRefElementType } from "#/editor/types";

const { openTabMock, useBlockMock } = vi.hoisted(() => ({
  openTabMock: vi.fn(),
  useBlockMock: vi.fn(),
}));

vi.mock("#/api/blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof BlocksApi>();
  return { ...actual, useBlock: useBlockMock };
});

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

const block: BlockResponse = {
  block_id: "abc123DEF0",
  block_type: "listitem",
  content: "Referenced sentence",
  page_path: "notes/source.md",
  page_title: "Source",
  span_start: 10,
  span_end: 50,
  properties: {},
};

function mockBlockContent(content: string) {
  useBlockMock.mockReturnValue({
    data: { ...block, content },
    error: null,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
}

function mockBlockError() {
  useBlockMock.mockReturnValue({
    data: undefined,
    error: new Error("Network unavailable"),
    isPending: false,
    isError: true,
    refetch: vi.fn(),
  });
}

function BlockRefHarness({ blockId }: { blockId: string }) {
  const [editor] = useState(() => withReact(withSchema(createEditor())));
  const controller = useInlineSourceEditingController(
    editor,
    INLINE_SOURCE_ADAPTERS,
  );
  const element: BlockRefElementType = {
    type: "block-ref",
    blockId,
    children: [{ text: "" }],
  };
  const value: Descendant[] = [
    { type: "paragraph", children: [{ text: "" }, element, { text: "" }] },
  ];
  const renderElement = (props: RenderElementProps) =>
    props.element.type === "block-ref" ? (
      <BlockRefElement
        {...props}
        element={props.element as BlockRefElementType}
      />
    ) : (
      <p {...props.attributes}>{props.children}</p>
    );
  return (
    <InlineSourceEditingProvider value={controller}>
      <Slate editor={editor} initialValue={value}>
        <Editable renderElement={renderElement} />
      </Slate>
    </InlineSourceEditingProvider>
  );
}

function renderBlockRef(blockId: string) {
  return render(<BlockRefHarness blockId={blockId} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BlockRefElement", () => {
  it("renders referenced content inside a non-editable inline void", () => {
    mockBlockContent("Referenced sentence");

    const { container } = renderBlockRef("abc123DEF0");

    expect(screen.getByText("Referenced sentence")).toBeVisible();
    const voidSpan = container.querySelector('[data-slate-void="true"]');
    expect(voidSpan).toHaveAttribute("contenteditable", "false");
    expect(
      screen.getByRole("button", { name: /Open referenced block/ }),
    ).toHaveAttribute("contenteditable", "false");
    expect(voidSpan?.lastElementChild).toHaveAttribute("data-slate-spacer");
  });

  it("keeps the retry action outside Slate editing", () => {
    mockBlockError();
    renderBlockRef("abc123DEF0");

    expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute(
      "contenteditable",
      "false",
    );
  });

  it("plumbs source navigation through the existing tab callback", async () => {
    const user = userEvent.setup();
    mockBlockContent("Referenced sentence");
    renderBlockRef("abc123DEF0");

    await user.click(
      screen.getByRole("button", { name: "Open referenced block in Source" }),
    );

    expect(openTabMock).toHaveBeenCalledWith(
      "page",
      "notes/source.md",
      "Source",
      { blockId: "abc123DEF0" },
    );
  });

  it("serializes rendered transclusion as the original reference", () => {
    mockBlockContent("Referenced sentence");
    const slate = markdownToSlate("See ((abc123DEF0)).");

    expect(slate).toEqual([
      {
        type: "paragraph",
        children: [
          { text: "See " },
          {
            type: "block-ref",
            blockId: "abc123DEF0",
            children: [{ text: "" }],
          },
          { text: "." },
        ],
      },
    ]);
    expect(slateToMarkdown(slate)).toContain("((abc123DEF0))");
    expect(slateToMarkdown(slate)).not.toContain("Referenced sentence");
  });
});

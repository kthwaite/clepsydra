import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RenderElementProps } from "slate-react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BlocksApi from "#/api/blocks";
import type { BlockResponse } from "#/api/blocks";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { BlockRefElement } from "#/editor/elements/BlockRefElement";
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

const attributes = {
  "data-slate-node": "element",
  "data-slate-inline": true,
  "data-slate-void": true,
  ref: () => {},
} as unknown as RenderElementProps["attributes"];

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

function renderBlockRef(blockId: string) {
  const element: BlockRefElementType = {
    type: "block-ref",
    blockId,
    children: [{ text: "" }],
  };
  return render(
    <BlockRefElement attributes={attributes} element={element}>
      <span data-testid="slate-child" />
    </BlockRefElement>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BlockRefElement", () => {
  it("renders referenced content inside a non-editable inline void", () => {
    mockBlockContent("Referenced sentence");

    const { container } = renderBlockRef("abc123DEF0");

    expect(screen.getByText("Referenced sentence")).toBeVisible();
    expect(container.firstElementChild).toHaveAttribute(
      "contenteditable",
      "false",
    );
    expect(
      screen.getByRole("button", { name: /Open referenced block/ }),
    ).toHaveAttribute("contenteditable", "false");
    expect(container.firstElementChild?.lastElementChild).toBe(
      screen.getByTestId("slate-child"),
    );
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

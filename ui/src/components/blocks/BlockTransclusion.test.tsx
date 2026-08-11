import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockResponse } from "#/api/blocks";
import {
  BlockTransclusion,
  blockDisplayContent,
} from "#/components/blocks/BlockTransclusion";

const { useBlockMock } = vi.hoisted(() => ({
  useBlockMock: vi.fn(),
}));

vi.mock("#/api/blocks", () => ({
  useBlock: useBlockMock,
}));

const block: BlockResponse = {
  block_id: "abc123DEF0",
  block_type: "listitem",
  content: "- Important note ((nested1234)) ^abc123DEF0",
  page_path: "source.md",
  page_title: "Source",
  span_start: 10,
  span_end: 64,
  properties: {},
};

function mockBlock(data: BlockResponse) {
  useBlockMock.mockReturnValue({
    data,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
}

function mockBlockError(status: number) {
  const refetch = vi.fn();
  useBlockMock.mockReturnValue({
    data: undefined,
    error: Object.assign(new Error("Block request failed"), { status }),
    isPending: false,
    isError: true,
    refetch,
  });
  return refetch;
}

beforeEach(() => {
  useBlockMock.mockReset();
});

describe("blockDisplayContent", () => {
  it("removes the list marker and exact terminal block ID", () => {
    expect(blockDisplayContent(block)).toBe(
      "Important note ((nested1234))",
    );
  });

  it("removes only structure belonging to the declared block type", () => {
    expect(
      blockDisplayContent({
        ...block,
        block_type: "heading",
        content: "### Heading **text** ^abc123DEF0",
      }),
    ).toBe("Heading **text**");
    expect(
      blockDisplayContent({
        ...block,
        block_type: "paragraph",
        content: "- Keep marker ^different123",
      }),
    ).toBe("- Keep marker ^different123");
  });
});

describe("BlockTransclusion", () => {
  it("renders an accessible loading state", () => {
    useBlockMock.mockReturnValue({
      data: undefined,
      isPending: true,
      isError: false,
      refetch: vi.fn(),
    });

    render(<BlockTransclusion blockId="abc123DEF0" onOpenSource={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading referenced block",
    );
  });

  it("renders one block as read-only source content without expanding nested references", () => {
    mockBlock(block);

    render(<BlockTransclusion blockId="abc123DEF0" onOpenSource={vi.fn()} />);

    expect(screen.getByText("Important note ((nested1234))")).toBeVisible();
    expect(screen.queryByTestId("block-transclusion-nested")).toBeNull();
  });

  it("renders Markdown and HTML syntax as inert text", () => {
    mockBlock({
      ...block,
      block_type: "paragraph",
      content:
        '<img src="/private.png" alt="unsafe"> **literal** ^abc123DEF0',
    });

    const { container } = render(
      <BlockTransclusion blockId="abc123DEF0" onOpenSource={vi.fn()} />,
    );

    expect(
      screen.getByText('<img src="/private.png" alt="unsafe"> **literal**'),
    ).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("strong")).toBeNull();
  });

  it("uses the unavailable state for a 404", () => {
    mockBlockError(404);

    render(<BlockTransclusion blockId="unknown1234" onOpenSource={vi.fn()} />);

    expect(screen.getByText("Referenced block unavailable")).toBeVisible();
  });

  it("offers retry after a transient error", async () => {
    const refetch = mockBlockError(503);
    const user = userEvent.setup();

    render(<BlockTransclusion blockId="abc123DEF0" onOpenSource={vi.fn()} />);
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(refetch).toHaveBeenCalledOnce();
  });

  it("uses the unavailable state when the query has no block", () => {
    useBlockMock.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: false,
      refetch: vi.fn(),
    });

    render(<BlockTransclusion blockId="abc123DEF0" onOpenSource={vi.fn()} />);

    expect(screen.getByText("Referenced block unavailable")).toBeVisible();
  });

  it("uses the unavailable state when structural content is empty", () => {
    mockBlock({
      ...block,
      content: "- ^abc123DEF0",
    });

    render(<BlockTransclusion blockId="abc123DEF0" onOpenSource={vi.fn()} />);

    expect(screen.getByText("Referenced block unavailable")).toBeVisible();
  });

  it("opens the resolved source through the callback contract", async () => {
    mockBlock(block);
    const onOpenSource = vi.fn();
    const user = userEvent.setup();

    render(
      <BlockTransclusion
        blockId="abc123DEF0"
        onOpenSource={onOpenSource}
        className="reference-inline"
      />,
    );
    await user.click(
      screen.getByRole("button", {
        name: "Open referenced block in Source",
      }),
    );

    expect(onOpenSource).toHaveBeenCalledOnce();
    expect(onOpenSource).toHaveBeenCalledWith(block);
    expect(screen.getByRole("group")).toHaveClass("reference-inline");
  });

  it("uses the source path in the accessible button name when title is absent", () => {
    mockBlock({ ...block, page_title: null });

    render(<BlockTransclusion blockId="abc123DEF0" onOpenSource={vi.fn()} />);

    expect(
      screen.getByRole("button", {
        name: "Open referenced block in source.md",
      }),
    ).toBeVisible();
  });
});

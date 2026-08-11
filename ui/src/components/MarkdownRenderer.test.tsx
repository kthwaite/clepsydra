import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BlockResponse } from "#/api/blocks";
import { MarkdownRenderer } from "#/components/MarkdownRenderer";

const { openTabMock, useBlockMock } = vi.hoisted(() => ({
  openTabMock: vi.fn(),
  useBlockMock: vi.fn(),
}));

vi.mock("#/api/blocks", async () => {
  const actual = await vi.importActual("#/api/blocks");
  return { ...actual, useBlock: useBlockMock };
});

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));

function mockBlock(blockId: string, content: string) {
  const block: BlockResponse = {
    block_id: blockId,
    block_type: "paragraph",
    content,
    page_path: "source.md",
    page_title: "Source",
    span_start: 0,
    span_end: content.length,
    properties: {},
  };
  useBlockMock.mockReturnValue({
    data: block,
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  });
}

function blockFetches(): string[] {
  return useBlockMock.mock.calls.map(([blockId]) => blockId);
}

beforeEach(() => {
  openTabMock.mockReset();
  useBlockMock.mockReset();
});

describe("MarkdownRenderer", () => {
  it("copies a fenced code block's text via its copy button", async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, "writeText");
    render(<MarkdownRenderer content={"```js\nconst answer = 42;\n```"} />);

    await user.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        expect.stringContaining("const answer = 42;"),
      ),
    );
  });

  it("does not add a copy button to inline code", () => {
    render(<MarkdownRenderer content={"some `inline` code"} />);
    expect(screen.queryByRole("button", { name: "Copy code" })).toBeNull();
  });

  it("marks recognized external resources without changing their accessible name", () => {
    render(
      <MarkdownRenderer
        content={
          "[Wikipedia](https://en.wikipedia.org/wiki/Hypertext) and [ordinary](https://example.com)"
        }
      />,
    );

    const wikipedia = screen.getByRole("link", { name: "Wikipedia" });
    expect(wikipedia).toHaveAttribute("data-link-resource", "wikipedia");
    expect(wikipedia).toHaveTextContent("Wikipedia");
    expect(screen.getByRole("link", { name: "ordinary" })).not.toHaveAttribute(
      "data-link-resource",
    );
  });

  it("does not mark internal page links", () => {
    render(<MarkdownRenderer content="[Local](/pages/notes/local.md)" />);
    expect(screen.getByRole("link", { name: "Local" })).not.toHaveAttribute(
      "data-link-resource",
    );
  });

  it("renders both delimiter families as inline and display math", () => {
    const { container } = render(
      <MarkdownRenderer
        content={String.raw`Dollar inline $x^2$ and backslash inline \(y + 1\).

$$
z = x + y
$$

\[
w = z^2
\]`}
      />,
    );

    expect(container.querySelectorAll(".katex")).toHaveLength(4);
    expect(
      container.querySelectorAll("span.folio-math:not(.folio-math--display)"),
    ).toHaveLength(2);
    expect(container.querySelectorAll("div.folio-math--display")).toHaveLength(
      2,
    );
  });

  it("preserves the exact authored source when TeX is invalid", () => {
    const source = String.raw`\(\notACommand{\)`;
    const { container } = render(<MarkdownRenderer content={source} />);

    const fallback = container.querySelector(".folio-math--invalid");
    expect(fallback).toHaveTextContent(source);
    expect(fallback).toHaveAttribute("aria-invalid", "true");
    expect(fallback).not.toHaveTextContent("KaTeX parse error");
  });

  it("excludes inline and fenced code from math rendering", () => {
    const { container } = render(
      <MarkdownRenderer
        content={"Inline code: `$x$`.\n\n```tex\n$$\nx^2\n$$\n```"}
      />,
    );

    expect(container.querySelector(".katex")).toBeNull();
    expect(screen.getByText("$x$")).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) =>
          element?.tagName === "CODE" &&
          element.textContent?.trim() === "$$\nx^2\n$$",
      ),
    ).toBeTruthy();
  });

  it("keeps raw HTML escaped", () => {
    const source =
      '<button type="button">activate</button><img src="https://example.test/math.png">';
    const { container } = render(<MarkdownRenderer content={source} />);

    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container).toHaveTextContent(source);
  });

  it("resolves CAS links and images through the vault blob endpoint", () => {
    render(
      <MarkdownRenderer
        content={
          "[Archived snapshot](cas:sha256:snapshot)\n\n![Archived image](cas:sha256:image)"
        }
      />,
    );

    expect(
      screen.getByRole("link", { name: "Archived snapshot" }),
    ).toHaveAttribute("href", "/api/vault/cas/sha256:snapshot");
    expect(screen.getByRole("img", { name: "Archived image" })).toHaveAttribute(
      "src",
      "/api/vault/cas/sha256:image",
    );
  });

  it("keeps block references inside link labels literal and non-interactive", () => {
    render(
      <MarkdownRenderer
        content={
          "[**See ((abc123DEF0))**](target.md) [Reference ((abc123DEF0))][source]\n\n[source]: source.md"
        }
      />,
    );

    expect(
      screen.getByRole("link", { name: "See ((abc123DEF0))" }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Reference ((abc123DEF0))" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", {
        name: "Open referenced block in Source",
      }),
    ).toBeNull();
    expect(useBlockMock).not.toHaveBeenCalled();
  });

  it("renders block content for a block reference", async () => {
    mockBlock("abc123DEF0", "Rendered from source");

    render(<MarkdownRenderer content="Before ((abc123DEF0)) after" />);

    expect(await screen.findByText("Rendered from source")).toBeVisible();
  });

  it("does not recursively resolve a nested reference in source content", async () => {
    mockBlock("abc123DEF0", "Outer ((nested1234))");

    render(<MarkdownRenderer content="((abc123DEF0))" />);

    expect(await screen.findByText(/Outer \(\(nested1234\)\)/)).toBeVisible();
    expect(blockFetches()).toEqual(["abc123DEF0"]);
  });

  it("opens a block reference source through the shared page callback", async () => {
    mockBlock("abc123DEF0", "Rendered from source");
    const user = userEvent.setup();
    render(<MarkdownRenderer content="((abc123DEF0))" />);

    await user.click(
      await screen.findByRole("button", {
        name: "Open referenced block in Source",
      }),
    );

    expect(openTabMock).toHaveBeenCalledWith("page", "source.md", "Source", {
      blockId: "abc123DEF0",
    });
  });

  it("renders malformed private block URLs as inert text", () => {
    render(
      <MarkdownRenderer
        content="[Malformed](clepsydra-block:short) [Unknown](other-scheme:abc123DEF0)"
      />,
    );

    expect(screen.getByText("Malformed").closest("a")).toBeNull();
    expect(screen.getByText("Unknown").closest("a")).toHaveAttribute("href", "");
  });

  it("does not preserve private block schemes in image destinations", () => {
    render(
      <MarkdownRenderer content="![Private](clepsydra-block:abc123DEF0)" />,
    );

    expect(screen.getByRole("img", { name: "Private" })).not.toHaveAttribute(
      "src",
    );
    expect(useBlockMock).not.toHaveBeenCalled();
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { createEditor } from "slate";
import { type RenderElementProps, Slate, withReact } from "slate-react";
import { describe, expect, it, vi } from "vitest";
import { LinkElement } from "#/editor/elements/LinkElement";
import { INLINE_SOURCE_ADAPTERS } from "#/editor/inlineSourceAdapters";
import {
  InlineSourceEditingProvider,
  useInlineSourceEditingController,
} from "#/editor/inlineSourceEditing";
import type { LinkElement as LinkElementType } from "#/editor/types";

const openTab = vi.hoisted(() => vi.fn());

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTab,
}));

const attributes = {
  "data-slate-node": "element",
  "data-slate-inline": true,
  ref: () => {},
} as unknown as RenderElementProps["attributes"];

/** LinkElement reads the Slate editor and the source-editing controller. */
function EditorContext({ children }: { children: ReactNode }) {
  const [editor] = useState(() => withReact(createEditor()));
  const controller = useInlineSourceEditingController(
    editor,
    INLINE_SOURCE_ADAPTERS,
  );
  return (
    <InlineSourceEditingProvider value={controller}>
      <Slate
        editor={editor}
        initialValue={[{ type: "paragraph", children: [{ text: "" }] }]}
      >
        {children}
      </Slate>
    </InlineSourceEditingProvider>
  );
}

function renderLink(url: string) {
  const element: LinkElementType = {
    type: "link",
    url,
    children: [{ text: "Wikipedia" }],
  };
  render(
    <LinkElement attributes={attributes} element={element}>
      Wikipedia
    </LinkElement>,
    { wrapper: EditorContext },
  );
  return screen.getByText("Wikipedia");
}

describe("LinkElement resource marks", () => {
  it("marks a recognized URL without adding editable or accessible text", () => {
    const link = renderLink("https://en.wikipedia.org/wiki/Hypertext");
    expect(link).toHaveAttribute("data-link-resource", "wikipedia");
    expect(link).toHaveTextContent(/^Wikipedia$/);
    expect(link.childNodes).toHaveLength(1);
  });

  it("does not mark a vault-relative link", () => {
    const link = renderLink("notes/local.md");
    expect(link).not.toHaveAttribute("data-link-resource");
    expect(link).not.toHaveAttribute("href");
  });

  it("exposes a CAS link through the vault blob endpoint", () => {
    const link = renderLink("cas:sha256:abc123");
    expect(link).toHaveAttribute("href", "/api/vault/cas/sha256:abc123");
  });

  it("marks and opens a prefixed link as its external URL", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = renderLink("arxiv:2301.00001");
    expect(link).toHaveAttribute("href", "https://arxiv.org/abs/2301.00001");
    expect(link).toHaveAttribute("data-link-resource", "arxiv");

    fireEvent.click(link, { metaKey: true });

    expect(open).toHaveBeenCalledWith(
      "https://arxiv.org/abs/2301.00001",
      "_blank",
      "noopener,noreferrer",
    );
    expect(openTab).not.toHaveBeenCalled();
    open.mockRestore();
  });
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { createEditor } from "slate";
import { type RenderElementProps, Slate, withReact } from "slate-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchClient } from "#/api/client";
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
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false, gcTime: 0 } },
      }),
  );
  const controller = useInlineSourceEditingController(
    editor,
    INLINE_SOURCE_ADAPTERS,
  );
  return (
    <QueryClientProvider client={queryClient}>
      <InlineSourceEditingProvider value={controller}>
        <Slate
          editor={editor}
          initialValue={[{ type: "paragraph", children: [{ text: "" }] }]}
        >
          {children}
        </Slate>
      </InlineSourceEditingProvider>
    </QueryClientProvider>
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

afterEach(() => vi.restoreAllMocks());

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

describe("LinkElement previews", () => {
  it("does not request anything until opened and leaves ordinary clicks editable", () => {
    const get = vi.spyOn(fetchClient, "GET");
    const post = vi.spyOn(fetchClient, "POST");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const link = renderLink("https://example.com");
    fireEvent.click(link);
    expect(link).toHaveAttribute("data-slate-inline", "true");
    expect(link).toHaveTextContent("Wikipedia");
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it("opens on hover and displays an opted-in local screenshot and metadata", async () => {
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: { enabled: true },
      response: new Response(),
    });
    vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: {
        state: "ready",
        title: "Example title",
        description: "Example description",
        final_url: "https://example.com",
        image_url: "/api/vault/external-previews/images/abc123",
        captured_at: "2026-10-16T12:00:00Z",
        refreshing: true,
      },
      response: new Response(),
    });
    const link = renderLink("https://example.com");
    fireEvent.mouseEnter(link);
    const image = await screen.findByRole("img", {
      name: "Screenshot of example.com",
    });
    expect(image).toHaveAttribute(
      "src",
      "/api/vault/external-previews/images/abc123",
    );
    expect(screen.getByText("Example title")).toBeVisible();
    expect(screen.getByText("Example description")).toBeVisible();
    expect(screen.getByText("example.com")).toBeVisible();
    expect(screen.getByText(/Captured/)).toBeVisible();
    expect(screen.getByText("Refreshing preview…")).toBeVisible();
    expect(screen.getByRole("button", { name: "Open" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    fireEvent.error(image);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Example title")).toBeVisible();
    expect(screen.getByText("Example description")).toBeVisible();
  });

  it("supports focus, panel traversal, Copy and Escape without enabling previews", async () => {
    const user = userEvent.setup();
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: { enabled: false },
      response: new Response(),
    });
    const post = vi.spyOn(fetchClient, "POST");
    const copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
    const link = renderLink("https://example.com");

    await user.tab();
    expect(link).toHaveFocus();
    expect(await screen.findByText(/External previews are off/)).toBeVisible();
    await user.tab();
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Copy" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(copy).toHaveBeenCalledWith("https://example.com");
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(link).toHaveFocus();
    expect(post).not.toHaveBeenCalled();
  });

  it("keeps metadata but rejects remote screenshot URLs", async () => {
    const user = userEvent.setup();
    vi.spyOn(fetchClient, "GET").mockResolvedValue({
      data: { enabled: true },
      response: new Response(),
    });
    vi.spyOn(fetchClient, "POST").mockResolvedValue({
      data: {
        state: "ready",
        title: "Metadata fallback",
        description: null,
        final_url: "https://example.com",
        image_url: "https://remote.example/screenshot.jpg",
        captured_at: null,
        refreshing: false,
      },
      response: new Response(),
    });
    renderLink("https://example.com");
    await user.tab();
    expect(await screen.findByText("Metadata fallback")).toBeVisible();
    expect(screen.getByText("Screenshot unavailable.")).toBeVisible();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it.each([
    "notes/local.md",
    "mailto:hello@example.com",
    "clep:page",
    "arxiv:2301.00001",
  ])(
    "retains the action popover without fetching a preview for %s",
    async (url) => {
      const user = userEvent.setup();
      const get = vi.spyOn(fetchClient, "GET");
      const post = vi.spyOn(fetchClient, "POST");
      renderLink(url);
      await user.tab();
      expect(
        screen.getByRole("dialog", { name: "Link preview" }),
      ).toBeVisible();
      expect(screen.getByRole("button", { name: "Open" })).toBeVisible();
      expect(screen.getByRole("button", { name: "Copy" })).toBeVisible();
      expect(get).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    },
  );
});

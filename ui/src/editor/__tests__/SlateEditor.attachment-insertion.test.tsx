import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { $api } from "#/api/client";
import { PageAttachmentGallery, PageAttachmentSection } from "#/components/attachments/PageAttachmentGallery";
import { SlateEditor } from "#/editor/SlateEditor";

describe("SlateEditor attachment insertion", () => {
  it("handles one external Markdown insertion request", async () => {
    const onInsertionHandled = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <SlateEditor
          initialValue={[{ type: "paragraph", children: [{ text: "Before" }] }]}
          onChange={vi.fn()}
          onSaveNow={vi.fn()}
          insertionRequest={{
            id: 7,
            markdown: "![diagram.png](/api/vault/attachments/diagram.png)",
          }}
          onInsertionHandled={onInsertionHandled}
        />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("img", { name: "diagram.png" }),
    ).toHaveAttribute("src", "/api/vault/attachments/diagram.png");
    await waitFor(() => expect(onInsertionHandled).toHaveBeenCalledWith(7));
  });

  it("opens an inline void in the page gallery without changing the document on arrow keys", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const queryClient = new QueryClient({
      defaultOptions: { queries: { enabled: false, retry: false } },
    });
    queryClient.setQueryData(
      $api.queryOptions("get", "/api/vault/attachments", {}).queryKey,
      ["inline.png", "footer.png"].map((name) => ({
        name, path: name, vault_path: `media/${name}`, size: 20,
      })),
    );
    render(
      <QueryClientProvider client={queryClient}>
        <PageAttachmentGallery
          pagePath="notes/current.md"
          markdown="![Inline](../media/inline.png)"
          attachedPaths={["footer.png"]}
        >
          <SlateEditor
            initialValue={[{
              type: "paragraph",
              children: [
                { text: "Before " },
                { type: "image", url: "../media/inline.png", alt: "Inline", children: [{ text: "" }] },
                { text: " after" },
              ],
            }]}
            onChange={onChange}
            onSaveNow={vi.fn()}
          />
          <PageAttachmentSection />
        </PageAttachmentGallery>
      </QueryClientProvider>,
    );
    const inline = screen.getByRole("img", { name: "Inline" });
    expect(inline).toHaveAttribute("src", "/api/vault/attachments/inline.png");
    expect(inline.closest('[contenteditable="false"]')).not.toBeNull();
    const trigger = screen.getByRole("button", { name: "Open image: Inline" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Image gallery" });
    onChange.mockClear();
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(within(dialog).getByText("footer.png")).toBeVisible();
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(within(dialog).getByText("inline.png")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});

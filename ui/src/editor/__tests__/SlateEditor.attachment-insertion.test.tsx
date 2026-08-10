import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});

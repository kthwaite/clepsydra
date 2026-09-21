import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { createEditor } from "slate";
import { Editable, Slate, withReact } from "slate-react";
import { describe, expect, it, vi } from "vitest";
import type * as ApiClientModule from "#/api/client";
import {
  BaseEmbedEditingProvider,
  useBaseEmbedEditingController,
} from "#/editor/baseEmbedEditing";
import { BaseRenderingProvider } from "#/editor/baseRendering";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { withSchema } from "#/editor/schema/withSchema";
import { renderElement } from "./renderElement";

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("#/api/client", async (original) => {
  const actual = await original<typeof ApiClientModule>();
  return { ...actual, fetchClient: { ...actual.fetchClient, POST: post } };
});
vi.mock("#/components/bases/BaseEmbedInspector", () => ({
  BaseEmbedInspector: () => null,
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));

function LiveHarness() {
  const [editor] = useState(() => withReact(withSchema(createEditor())));
  const [saved, setSaved] = useState("");
  const editing = useBaseEmbedEditingController(editor);
  return (
    <BaseRenderingProvider
      value={{
        pagePath: "notes/destination.md",
        readonly: false,
        beginGeneratedChange: async () => {
          throw new Error("Not used by live rendering");
        },
      }}
    >
      <Slate
        editor={editor}
        initialValue={markdownToSlate(
          '```base\nbase = "readings"\ntemplate = "notes"\n```\n',
        )}
      >
        <BaseEmbedEditingProvider value={editing}>
          <Editable renderElement={renderElement} />
          <button
            type="button"
            onClick={() => setSaved(slateToMarkdown(editor.children))}
          >
            Read saved Markdown
          </button>
          <output>{saved}</output>
        </BaseEmbedEditingProvider>
      </Slate>
    </BaseRenderingProvider>
  );
}

describe("live template rendering", () => {
  it("shows normal Markdown but saves only the template fence and never executes a nested Base", async () => {
    post.mockResolvedValue({
      data: {
        markdown:
          '# Fresh report\n\nA **complete** paragraph.\n\n```base\nbase = "nested"\nview = "All"\n```\n',
        selected_count: 1,
      },
    });
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <LiveHarness />
      </QueryClientProvider>,
    );
    expect(
      await screen.findByRole("heading", { name: "Fresh report" }),
    ).toBeVisible();
    expect(screen.getByText("complete", { selector: "strong" })).toBeVisible();
    expect(
      screen.getByText(/base = "nested"/, { selector: "code" }),
    ).toBeVisible();
    fireEvent.click(
      screen.getByRole("button", { name: "Read saved Markdown" }),
    );
    const persisted = screen.getByRole("status").textContent;
    expect(persisted).toContain('template = "notes"');
    expect(persisted).not.toContain("Fresh report");
    expect(post).toHaveBeenCalledTimes(1);
  });
});

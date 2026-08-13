import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { Descendant } from "slate";
import { describe, expect, it, vi } from "vitest";
import { SlateEditor } from "#/editor/SlateEditor";
import type { CustomEditor } from "#/editor/types";

function renderEditor(onUnmountSnapshot: (editor: CustomEditor) => void) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  const editorRef = { current: null as CustomEditor | null };
  const initialValue: Descendant[] = [
    { type: "paragraph", children: [{ text: "body" }] } as Descendant,
  ];
  const view = render(
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={initialValue}
        onChange={() => {}}
        onSaveNow={() => {}}
        editorRef={editorRef}
        onUnmountSnapshot={onUnmountSnapshot}
      />
    </QueryClientProvider>,
  );
  return { view, editorRef };
}

describe("SlateEditor unmount snapshot", () => {
  it("hands the live editor instance to onUnmountSnapshot at unmount", () => {
    const onUnmountSnapshot = vi.fn();
    const { view, editorRef } = renderEditor(onUnmountSnapshot);
    const mounted = editorRef.current;
    expect(mounted).not.toBeNull();
    expect(onUnmountSnapshot).not.toHaveBeenCalled();

    view.unmount();

    expect(onUnmountSnapshot).toHaveBeenCalledOnce();
    expect(onUnmountSnapshot).toHaveBeenCalledWith(mounted);
  });
});

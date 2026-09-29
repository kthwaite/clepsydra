import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  createEvent,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef } from "react";
import { Editor, Node, Transforms } from "slate";
import { ReactEditor } from "slate-react";
import { afterEach, expect, it, vi } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import { SlateEditor, type SlateEditorProps } from "#/editor/SlateEditor";
import type { CustomEditor } from "#/editor/types";

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));

function pendingUpload() {
  let resolve!: (markdown: string | null) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string | null>(
    (resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    },
  );
  return { promise, resolve, reject };
}

function renderEditor(
  onFilesDrop: SlateEditorProps["onFilesDrop"],
  readOnly = false,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false } },
  });
  const editorRef = createRef<CustomEditor>();
  const initialValue: SlateEditorProps["initialValue"] = [
    { type: "paragraph", children: [{ text: "first second" }] },
    { type: "paragraph", children: [{ text: "elsewhere" }] },
  ];
  const view = (locked: boolean, key = "one") => (
    <QueryClientProvider client={client}>
      <SlateEditor
        key={key}
        initialValue={initialValue}
        onChange={() => undefined}
        onSaveNow={() => undefined}
        onFilesDrop={onFilesDrop}
        readOnly={locked}
        editorRef={editorRef}
      />
    </QueryClientProvider>
  );
  const rendered = render(view(readOnly));
  const editor = editorRef.current;
  if (!editor) throw new Error("Editor did not mount");
  const editable = rendered.container.querySelector("[data-slate-editor]");
  if (!editable) throw new Error("Editable did not mount");
  const dropPoint = { path: [0, 0], offset: 6 };
  const findRange = vi.spyOn(ReactEditor, "findEventRange").mockReturnValue({
    anchor: dropPoint,
    focus: dropPoint,
  });
  return {
    ...rendered,
    editor,
    editorRef,
    editable,
    findRange,
    rerenderEditor: (locked: boolean, key?: string) =>
      rendered.rerender(view(locked, key)),
  };
}

function transfer(
  files = [new File(["pdf"], "report.pdf", { type: "application/pdf" })],
) {
  return {
    files,
    items: files.map((file) => ({ kind: "file", type: file.type })),
    types: ["Files", "text/plain"],
    dropEffect: "none",
    getData: () => "must not insert external text",
  };
}

afterEach(() => vi.restoreAllMocks());

it("inserts at the live drop point after edits without replacing or stealing the later selection", async () => {
  const upload = pendingUpload();
  const { editor, editable } = renderEditor(() => upload.promise);
  await act(async () => {
    Transforms.select(editor, {
      anchor: { path: [1, 0], offset: 0 },
      focus: { path: [1, 0], offset: 9 },
    });
  });
  const drop = createEvent.drop(editable, { dataTransfer: transfer() });
  fireEvent(editable, drop);
  expect(drop.defaultPrevented).toBe(true);
  await act(async () => {
    Transforms.insertText(editor, "New ", { at: { path: [0, 0], offset: 0 } });
    Transforms.select(editor, {
      anchor: { path: [1, 0], offset: 2 },
      focus: { path: [1, 0], offset: 5 },
    });
    upload.resolve("[report.pdf](/api/vault/attachments/report.pdf)");
  });
  expect(Node.string(editor.children[0])).toBe("New first report.pdfsecond");
  expect(Node.string(editor.children[1])).toBe("elsewhere");
  expect(editor.selection).toEqual({
    anchor: { path: [1, 0], offset: 2 },
    focus: { path: [1, 0], offset: 5 },
  });
  expect(slateToMarkdown(editor.children)).toContain(
    "New first [report.pdf](/api/vault/attachments/report.pdf)second",
  );
  expect(Editor.rangeRefs(editor).size).toBe(0);
});

it("shows a multi-file count without exposed filenames and keeps feedback across nested dragleave", () => {
  const { editable } = renderEditor(async () => null);
  const data = {
    files: [],
    items: [
      { kind: "file", type: "image/png" },
      { kind: "file", type: "application/pdf" },
    ],
    types: ["Files"],
    dropEffect: "none",
  };
  const child = screen.getByText("first second");
  for (const target of [editable, child]) {
    const event = new MouseEvent("dragenter", {
      bubbles: true,
      cancelable: true,
      clientX: 20,
      clientY: 40,
    });
    Object.defineProperty(event, "dataTransfer", { value: data });
    fireEvent(target, event);
  }
  expect(screen.getByText(/2 files/)).toBeVisible();
  expect(data.dropEffect).toBe("copy");
  fireEvent.dragLeave(child, { dataTransfer: data });
  expect(screen.getByText(/2 files/)).toBeVisible();
  fireEvent.dragLeave(editable, { dataTransfer: data });
  expect(screen.queryByText(/2 files/)).not.toBeInTheDocument();
});

it.each([true, false])(
  "blocks file navigation without uploading when readOnly=%s or no uploader exists",
  (readOnly) => {
    const upload = vi.fn(
      async () => "[report.pdf](/api/vault/attachments/report.pdf)",
    );
    const { editable, editor } = renderEditor(
      readOnly ? upload : undefined,
      readOnly,
    );
    const drop = createEvent.drop(editable, { dataTransfer: transfer() });
    fireEvent(editable, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(upload).not.toHaveBeenCalled();
    expect(Node.string(editor)).toBe("first secondelsewhere");
  },
);

it("preserves Markdown text drops without uploading", async () => {
  const upload = vi.fn(async () => null);
  const { editable, editor } = renderEditor(upload);
  const data = {
    files: [],
    items: [{ kind: "string", type: "text/plain" }],
    types: ["text/plain"],
    getData: (type: string) => (type === "text/plain" ? "**dropped**" : ""),
  };
  await act(async () => fireEvent.drop(editable, { dataTransfer: data }));
  expect(editor.children[0]).toMatchObject({
    type: "paragraph",
    children: [
      { text: "first " },
      { text: "dropped", bold: true },
      { text: "second" },
    ],
  });
  expect(upload).not.toHaveBeenCalled();
});

it("cancels a pending target when editing is disabled, even if editing resumes before upload completes", async () => {
  const upload = pendingUpload();
  const { editor, editable, rerenderEditor } = renderEditor(
    () => upload.promise,
  );
  fireEvent.drop(editable, { dataTransfer: transfer() });
  rerenderEditor(true);
  expect(Editor.rangeRefs(editor).size).toBe(0);
  rerenderEditor(false);
  await act(async () =>
    upload.resolve("[report.pdf](/api/vault/attachments/report.pdf)"),
  );
  expect(Node.string(editor)).toBe("first secondelsewhere");
});

it("does not insert an old upload after a keyed Folio or revision replacement", async () => {
  const upload = pendingUpload();
  const { editor, editorRef, editable, rerenderEditor } = renderEditor(
    () => upload.promise,
  );
  fireEvent.drop(editable, { dataTransfer: transfer() });
  rerenderEditor(false, "replacement");
  expect(Editor.rangeRefs(editor).size).toBe(0);
  await act(async () =>
    upload.resolve("[report.pdf](/api/vault/attachments/report.pdf)"),
  );
  expect(Node.string(editor)).toBe("first secondelsewhere");
  expect(editorRef.current && Node.string(editorRef.current)).toBe(
    "first secondelsewhere",
  );
});

it("explains that uploaded files remain in the attachment pane when their target is removed", async () => {
  const upload = pendingUpload();
  const { editor, editable } = renderEditor(() => upload.promise);
  fireEvent.drop(editable, { dataTransfer: transfer() });
  await act(async () => {
    Transforms.removeNodes(editor, { at: [0] });
    upload.resolve("[report.pdf](/api/vault/attachments/report.pdf)");
  });
  expect(screen.getByRole("alert")).toHaveTextContent(/attachment pane/);
  expect(Node.string(editor)).toBe("elsewhere");
  expect(Editor.rangeRefs(editor).size).toBe(0);
});

it("shows callback failures and accepts another drop after clearing busy state", async () => {
  const failed = pendingUpload();
  const upload = vi
    .fn()
    .mockReturnValueOnce(failed.promise)
    .mockResolvedValueOnce("[report.pdf](/api/vault/attachments/report.pdf)");
  const { editor, editable } = renderEditor(upload);
  fireEvent.drop(editable, { dataTransfer: transfer() });
  await act(async () => failed.reject(new Error("Upload unavailable")));
  expect(screen.getByRole("alert")).toHaveTextContent("Upload unavailable");
  expect(Node.string(editor)).toBe("first secondelsewhere");
  expect(Editor.rangeRefs(editor).size).toBe(0);
  await act(async () => fireEvent.drop(editable, { dataTransfer: transfer() }));
  expect(slateToMarkdown(editor.children)).toContain(
    "[report.pdf](/api/vault/attachments/report.pdf)",
  );
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("keeps the document unchanged when all uploads are canceled", async () => {
  const { editor, editable } = renderEditor(async () => null);
  await act(async () => fireEvent.drop(editable, { dataTransfer: transfer() }));
  expect(Node.string(editor)).toBe("first secondelsewhere");
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
  expect(Editor.rangeRefs(editor).size).toBe(0);
});

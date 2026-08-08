import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { type Descendant, Editor, Transforms } from "slate";
import { beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ResolvedWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";

const { editorRef, openTabMock, resolveOrCreateMock } = vi.hoisted(() => ({
  editorRef: { current: null as Editor | null },
  openTabMock: vi.fn(),
  resolveOrCreateMock: vi.fn(),
}));

vi.mock("#/api/pages", () => ({
  usePages: () => ({ data: { items: [] } }),
}));
vi.mock("#/editor/useResolveOrCreateWikilinkTarget", () => ({
  useResolveOrCreateWikilinkTarget: () => ({
    resolveOrCreate: resolveOrCreateMock,
  }),
}));
vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => openTabMock,
}));
vi.mock("#/editor/floatingSelectionReference", () => ({
  createSelectionReference: () => ({
    getBoundingClientRect: () => new DOMRect(120, 80, 0, 18),
  }),
}));
vi.mock("slate-react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const OriginalSlate = actual.Slate as ComponentType<
    { editor: Editor } & Record<string, unknown>
  >;
  return {
    ...actual,
    Slate: (props: { editor: Editor } & Record<string, unknown>) => {
      editorRef.current = props.editor;
      return <OriginalSlate {...props} />;
    },
  };
});

import { SlateEditor } from "#/editor/SlateEditor";

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  window.getSelection()?.removeAllRanges();
  editorRef.current = null;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function findWikilinks(value: Descendant[]) {
  const links: Array<{ type: string; target: string }> = [];
  const visit = (node: Descendant) => {
    if ("type" in node && node.type === "wikilink") {
      links.push({ type: node.type, target: node.target });
    }
    if ("children" in node) {
      for (const child of node.children) visit(child as Descendant);
    }
  };
  for (const node of value) visit(node);
  return links;
}

function renderEditor() {
  const changes: Descendant[][] = [];
  const user = userEvent.setup();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SlateEditor
        initialValue={[
          { type: "paragraph", children: [{ text: "" }] } as Descendant,
        ]}
        onChange={(value) => changes.push(structuredClone(value))}
        onSaveNow={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return {
    user,
    editable: screen.getByRole("textbox"),
    latestChanges: () => changes.at(-1) ?? [],
    typeText: async (text: string) => {
      const editor = editorRef.current;
      if (!editor) throw new Error("Slate editor is not active");
      await act(async () => {
        Transforms.select(editor, Editor.end(editor, []));
        Transforms.insertText(editor, text);
      });
    },
    replaceText: (text: string) => {
      const editor = editorRef.current;
      if (!editor) throw new Error("Slate editor is not active");
      Transforms.select(editor, Editor.range(editor, []));
      Transforms.delete(editor);
      Transforms.insertText(editor, text);
    },
  };
}

it("creates in the background and inserts the requested wikilink", async () => {
  resolveOrCreateMock.mockResolvedValue({
    path: "notes/20260808.new-topic.a1B2c3D4.md",
    title: "New Topic",
  });
  const { user, editable, latestChanges, typeText } = renderEditor();

  await user.click(editable);
  await typeText("[[New Topic");
  expect(editable).toHaveTextContent("[[New Topic");
  await user.click(screen.getByText('Create “New Topic”'));

  await waitFor(() =>
    expect(resolveOrCreateMock).toHaveBeenCalledWith("New Topic"),
  );
  expect(screen.queryByText('Create “New Topic”')).toBeNull();
  expect(latestChanges()).toEqual([
    {
      type: "paragraph",
      children: [
        { text: "" },
        {
          type: "wikilink",
          target: "New Topic",
          alias: undefined,
          children: [{ text: "" }],
        },
        { text: "" },
      ],
    },
  ]);
  expect(editable).toHaveFocus();
  expect(openTabMock).not.toHaveBeenCalled();
});

it("retries after failure and inserts only after the retry succeeds", async () => {
  resolveOrCreateMock
    .mockRejectedValueOnce(new Error("create failed"))
    .mockResolvedValueOnce({
      path: "notes/new-topic.md",
      title: "New Topic",
    });
  const { user, editable, latestChanges, typeText } = renderEditor();
  await user.click(editable);
  await typeText("[[New Topic");
  await user.click(screen.getByText('Create “New Topic”'));

  await screen.findByText("Creation failed — press Enter to retry");
  expect(findWikilinks(latestChanges())).toEqual([]);
  expect(screen.getByRole("listbox")).toBeInTheDocument();

  await user.keyboard("{Enter}");
  await waitFor(() => expect(resolveOrCreateMock).toHaveBeenCalledTimes(2));
  expect(resolveOrCreateMock).toHaveBeenNthCalledWith(2, "New Topic");
  expect(findWikilinks(latestChanges())).toEqual([
    { type: "wikilink", target: "New Topic" },
  ]);
  expect(
    screen.queryByText("Creation failed — press Enter to retry"),
  ).toBeNull();
  expect(screen.queryByRole("listbox")).toBeNull();
  expect(editable).toHaveFocus();
  expect(openTabMock).not.toHaveBeenCalled();
});

it("ignores repeat activation while creation is pending", async () => {
  const pending = deferred<ResolvedWikilinkTarget>();
  resolveOrCreateMock.mockReturnValue(pending.promise);
  const { user, editable, typeText } = renderEditor();
  await user.click(editable);
  await typeText("[[New Topic");
  await user.keyboard("{Enter}{Enter}");

  expect(resolveOrCreateMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    pending.resolve({ path: "notes/new-topic.md", title: "New Topic" });
    await pending.promise;
  });
});

it("creates for a new trigger while an older request is pending", async () => {
  const first = deferred<ResolvedWikilinkTarget>();
  const second = deferred<ResolvedWikilinkTarget>();
  resolveOrCreateMock.mockImplementation((title: string) =>
    title === "First" ? first.promise : second.promise,
  );
  const { user, editable, latestChanges, replaceText, typeText } =
    renderEditor();
  await user.click(editable);
  await typeText("[[First");
  await user.keyboard("{Enter}");
  expect(resolveOrCreateMock).toHaveBeenNthCalledWith(1, "First");

  await act(async () => replaceText("[[Second"));
  expect(screen.getByText('Create “Second”')).toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(resolveOrCreateMock).toHaveBeenNthCalledWith(2, "Second");

  await act(async () => {
    first.resolve({ path: "notes/first.md", title: "First" });
    await first.promise;
  });
  expect(findWikilinks(latestChanges())).toEqual([]);
  expect(screen.getByText("Creating…")).toBeInTheDocument();
  expect(
    screen.queryByText("Creation failed — press Enter to retry"),
  ).toBeNull();
  await user.keyboard("{Enter}");
  expect(resolveOrCreateMock).toHaveBeenCalledTimes(2);

  await act(async () => {
    second.resolve({ path: "notes/second.md", title: "Second" });
    await second.promise;
  });
  expect(findWikilinks(latestChanges())).toEqual([
    { type: "wikilink", target: "Second" },
  ]);
  expect(editable).toHaveFocus();
  expect(openTabMock).not.toHaveBeenCalled();
});

it("does not insert after the initiating trigger closes", async () => {
  const pending = deferred<ResolvedWikilinkTarget>();
  resolveOrCreateMock.mockReturnValue(pending.promise);
  const { user, editable, latestChanges, typeText } = renderEditor();
  await user.click(editable);
  await typeText("[[First");
  await user.keyboard("{Enter}{Escape}");
  expect(resolveOrCreateMock).toHaveBeenCalledWith("First");

  pending.resolve({ path: "notes/first.md", title: "First" });
  await act(async () => pending.promise);
  expect(findWikilinks(latestChanges())).toEqual([]);
  expect(openTabMock).not.toHaveBeenCalled();
});

it("does not insert into a different live trigger", async () => {
  const pending = deferred<ResolvedWikilinkTarget>();
  resolveOrCreateMock.mockReturnValue(pending.promise);
  const { user, editable, latestChanges, replaceText, typeText } =
    renderEditor();
  await user.click(editable);
  await typeText("[[First");
  await user.keyboard("{Enter}");
  expect(resolveOrCreateMock).toHaveBeenCalledWith("First");

  await act(async () => {
    replaceText("[[Second");
    pending.resolve({ path: "notes/first.md", title: "First" });
    await pending.promise;
  });

  expect(findWikilinks(latestChanges())).toEqual([]);
  expect(latestChanges()).toEqual([
    { type: "paragraph", children: [{ text: "[[Second" }] },
  ]);
  expect(screen.getByText('Create “Second”')).toBeInTheDocument();
  expect(openTabMock).not.toHaveBeenCalled();
});

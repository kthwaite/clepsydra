import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type * as BlocksApi from "#/api/blocks";
import type * as ApiClient from "#/api/client";
import type * as PagesApi from "#/api/pages";
import type * as WikilinkResolution from "#/editor/wikilinkResolution";
import { type Descendant, type Editor, Transforms } from "slate";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { slateToMarkdown } from "#/editor/convert";
import { SlateEditor } from "#/editor/SlateEditor";
import { makeWikilink } from "#/editor/schema/elements/wikilink";

const {
  assignBlockIdMock,
  createPageMock,
  refetchAndLookupMock,
  searchGetMock,
} = vi.hoisted(() => ({
  assignBlockIdMock: vi.fn(),
  createPageMock: vi.fn(),
  refetchAndLookupMock: vi.fn(),
  searchGetMock: vi.fn(),
}));

vi.mock("#/api/pages", async (importOriginal) => {
  const actual = await importOriginal<typeof PagesApi>();
  return {
    ...actual,
    usePages: () => ({
      data: {
        items: [
          {
            id: "page-1",
            title: "My Page",
            canonical_name: "my-page",
            path: "notes/my-page.md",
          },
        ],
      },
    }),
    useCreatePage: () => ({
      mutateAsync: createPageMock,
      isPending: false,
    }),
  };
});

vi.mock("#/api/blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof BlocksApi>();
  return {
    ...actual,
    useAssignBlockId: () => ({ mutateAsync: assignBlockIdMock }),
  };
});

vi.mock("#/editor/wikilinkResolution", async (importOriginal) => {
  const actual = await importOriginal<typeof WikilinkResolution>();
  return {
    ...actual,
    useWikilinkResolution: () => ({
      lookup: () => null,
      refetchAndLookup: refetchAndLookupMock,
    }),
  };
});

vi.mock("#/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof ApiClient>();
  return {
    ...actual,
    fetchClient: { ...actual.fetchClient, GET: searchGetMock },
  };
});

beforeAll(() => {
  // jsdom leaves isContentEditable unimplemented; slate-react's
  // hasEditableTarget guard needs it to route keydown to onKeyDown props.
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return this.closest('[contenteditable="true"]') !== null;
    },
  });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => Object.assign([], { item: () => null }),
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  createPageMock.mockResolvedValue(undefined);
  refetchAndLookupMock.mockResolvedValue(null);
  searchGetMock.mockResolvedValue({ data: [] });
});

function makeParagraph(children: Descendant[]): Descendant {
  return { type: "paragraph", children } as Descendant;
}

// jsdom does not synthesize contenteditable beforeinput. Drive the real
// editor.insertText pipeline so schema, autoformat, and onChange stay active.
function typeInSlate(editor: Editor, text: string) {
  act(() => {
    for (const data of text) editor.insertText(data);
  });
}

function renderEditor(initialValue: Descendant[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  let latestValue = initialValue;
  let latestEditor: Editor | null = null;

  const editorView = (
    <SlateEditor
      initialValue={initialValue}
      onChange={(value, editor) => {
        latestValue = value;
        latestEditor = editor;
      }}
      onSaveNow={() => {}}
    />
  );
  const rootRoute = createRootRoute({ component: () => editorView });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });

  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );

  return {
    getValue: () => latestValue,
    getEditor: () => latestEditor,
  };
}

async function selectSlatePoint(
  editable: HTMLElement,
  getEditor: () => Editor | null,
  path: number[],
  offset: number,
) {
  const user = userEvent.setup();
  await user.click(editable);
  await waitFor(() => expect(getEditor()).not.toBeNull());
  act(() => {
    Transforms.select(getEditor() as Editor, { path, offset });
  });
}


describe("SlateEditor wikilink editing integration", () => {
  it("completes a target, enters from the right, and persists the typed label", async () => {
    const user = userEvent.setup();
    const editor = renderEditor([makeParagraph([{ text: "" }])]);
    const editable = await screen.findByRole("textbox");

    await user.click(editable);
    typeInSlate(editor.getEditor() as Editor, "[[My");
    await user.keyboard("{Tab}");
    expect(screen.getByRole("link", { name: "My Page" })).toBeInTheDocument();
    await user.keyboard("{ArrowLeft}");
    const input = screen.getByRole("textbox", { name: "Edit wikilink" });
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionStart).toBe("My Page".length);
    await user.type(input, "|short label", { skipClick: true });
    expect(input).toHaveValue("My Page|short label");
    await user.keyboard("{Enter}");
    expect(slateToMarkdown(editor.getValue())).toContain(
      "[[My Page|short label]]",
    );

    expect(
      screen.getByRole("link", { name: "short label" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("My Page")).toBeNull();
  });

  it("autoformats a directly typed labeled wikilink to its passive label", async () => {
    const user = userEvent.setup();
    const editor = renderEditor([makeParagraph([{ text: "" }])]);
    const editable = await screen.findByRole("textbox");

    await user.click(editable);
    typeInSlate(editor.getEditor() as Editor, "[[My Page|direct label]]");

    await waitFor(() =>
      expect(slateToMarkdown(editor.getValue())).toContain(
        "[[My Page|direct label]]",
      ),
    );
    expect(
      screen.getByRole("link", { name: "direct label" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("My Page")).toBeNull();
  });

  it("enters a following wikilink at draft start and Escape returns before it", async () => {
    const harness = renderEditor([
      makeParagraph([
        { text: "Before " },
        makeWikilink({ target: "My Page", alias: "Original label" }),
        { text: " after" },
      ]),
    ]);
    const editable = await screen.findByRole("textbox");
    await selectSlatePoint(
      editable,
      harness.getEditor,
      [0, 0],
      "Before ".length,
    );

    fireEvent.keyDown(editable, { key: "ArrowRight" });

    const input = screen.getByRole("textbox", { name: "Edit wikilink" });
    expect(input).toHaveValue("My Page|Original label");
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionStart).toBe(0);

    await userEvent.setup().type(input, "changed ");
    await userEvent.setup().keyboard("{Escape}");

    expect(
      screen.getByRole("link", { name: "Original label" }),
    ).toBeInTheDocument();
    expect(slateToMarkdown(harness.getValue())).toContain(
      "[[My Page|Original label]]",
    );
    expect(harness.getEditor()?.selection?.anchor).toEqual({
      path: [0, 0],
      offset: "Before ".length,
    });
  });

  it("enters a preceding wikilink at draft end and Escape returns after it", async () => {
    const harness = renderEditor([
      makeParagraph([
        { text: "Before " },
        makeWikilink({ target: "My Page", alias: "Original label" }),
        { text: " after" },
      ]),
    ]);
    const editable = await screen.findByRole("textbox");
    await selectSlatePoint(editable, harness.getEditor, [0, 2], 0);

    fireEvent.keyDown(editable, { key: "ArrowLeft" });

    const input = screen.getByRole("textbox", { name: "Edit wikilink" });
    expect(input).toHaveValue("My Page|Original label");
    expect(input).toHaveFocus();
    expect((input as HTMLInputElement).selectionStart).toBe(
      "My Page|Original label".length,
    );

    await userEvent.setup().type(input, " changed");
    await userEvent.setup().keyboard("{Escape}");

    expect(
      screen.getByRole("link", { name: "Original label" }),
    ).toBeInTheDocument();
    expect(slateToMarkdown(harness.getValue())).toContain(
      "[[My Page|Original label]]",
    );
    expect(harness.getEditor()?.selection?.anchor).toEqual({
      path: [0, 2],
      offset: 0,
    });
  });
});

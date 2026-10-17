import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { Transforms } from "slate";
import { HistoryEditor } from "slate-history";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const transport = vi.hoisted(() => {
  const fetch = vi.fn<typeof globalThis.fetch>();
  const NativeRequest = globalThis.Request;
  class SameOriginRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" && input.startsWith("/")
          ? new URL(input, "http://localhost")
          : input,
        init,
      );
    }
  }
  vi.stubGlobal("Request", SameOriginRequest);
  vi.stubGlobal("fetch", fetch);
  Object.defineProperty(InputEvent.prototype, "getTargetRanges", {
    configurable: true,
    value: () => {
      const selection = window.getSelection();
      return selection?.rangeCount ? [selection.getRangeAt(0)] : [];
    },
  });
  return { fetch, openTab: vi.fn() };
});
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => transport.openTab }));

import { invalidatePageContent } from "#/api/keys";
import { BaseRenderingProvider } from "#/editor/baseRendering";
import { markdownToSlate, slateToMarkdown } from "#/editor/convert";
import { SlateEditor } from "#/editor/SlateEditor";
import type { CustomEditor } from "#/editor/types";

let results: {
  page_id: string;
  path: string;
  title: string;
  snippet: string;
  rank: number;
}[];
let failure: "syntax" | "network" | undefined;
const clients: QueryClient[] = [];

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "isContentEditable", {
    configurable: true,
    get(this: HTMLElement) {
      return (
        this.closest("[contenteditable]")?.getAttribute("contenteditable") ===
        "true"
      );
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
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  window.getSelection()?.removeAllRanges();
  failure = undefined;
  results = [
    {
      page_id: "clock",
      path: "notes/clock.md",
      title: "Water clock",
      snippet:
        "<mark>Water</mark> [[Clock|mechanism]] <img src=x onerror=alert(1)>",
      rank: -1,
    },
  ];
  transport.openTab.mockReset();
  transport.fetch.mockReset();
  transport.fetch.mockImplementation(async (request) => {
    const url = new URL(
      request instanceof Request ? request.url : String(request),
    );
    if (url.pathname === "/api/vault/index/search") {
      if (failure)
        return new Response(
          JSON.stringify({
            status: failure === "syntax" ? 400 : 503,
            error:
              failure === "syntax"
                ? "Unknown search field 'knd'."
                : "Unavailable",
            detail:
              failure === "syntax"
                ? {
                    code: "invalid_search_query",
                    kind: "unknown_field",
                    span: { start: 0, end: 3 },
                  }
                : null,
          }),
          {
            status: failure === "syntax" ? 400 : 503,
            headers: { "Content-Type": "application/json" },
          },
        );
      return Response.json(
        results.slice(0, Number(url.searchParams.get("limit") ?? 20)),
      );
    }
    return Response.json([]);
  });
});
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

function mount(source: string, readOnly = false, protectedHost = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  clients.push(client);
  const editorRef = createRef<CustomEditor>();
  const editorView = (
    <SlateEditor
      initialValue={markdownToSlate(source)}
      editorRef={editorRef}
      onChange={() => {}}
      onSaveNow={() => {}}
      readOnly={readOnly}
    />
  );
  const view = render(
    <QueryClientProvider client={client}>
      {protectedHost ? (
        <BaseRenderingProvider
          value={{
            pagePath: "private.md",
            readonly: true,
            serializeMarkdown: slateToMarkdown,
            beginGeneratedChange: vi.fn(),
          }}
        >
          {editorView}
        </BaseRenderingProvider>
      ) : (
        editorView
      )}
    </QueryClientProvider>,
    { reactStrictMode: true },
  );
  const editor = editorRef.current;
  if (!editor) throw new Error("Editor did not mount");
  return { ...view, editor, client, user: userEvent.setup() };
}
const source = '```search\nquery = "water"\nlimit = 1\n```\n';

describe("saved search in the mounted note editor", () => {
  it("inserts from slash, buffers configuration, applies, reloads, and undoes an edit", async () => {
    const view = mount("");
    const editable = view.container.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!editable) throw new Error("Editable missing");
    await view.user.click(editable);
    act(() => Transforms.select(view.editor, { path: [0, 0], offset: 0 }));
    await view.user.type(editable, "/search");
    fireEvent.mouseDown(
      await screen.findByRole("option", { name: /Search embed/ }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Configure search embed",
    });
    await view.user.type(
      within(dialog).getByRole("textbox", { name: "Query" }),
      "water",
    );
    expect(slateToMarkdown(view.editor.children)).not.toContain(
      'query = "water"',
    );
    await view.user.click(
      within(dialog).getByRole("button", { name: "Apply" }),
    );
    expect(
      await screen.findByRole("button", { name: "Water clock" }),
    ).toBeVisible();
    const saved = slateToMarkdown(view.editor.children);
    view.unmount();
    const reloaded = mount(saved);
    await reloaded.user.click(
      screen.getByRole("button", { name: "Edit search" }),
    );
    const query = screen.getByRole("textbox", { name: "Query" });
    await reloaded.user.clear(query);
    await reloaded.user.type(query, "kind:NOTE");
    await reloaded.user.click(screen.getByRole("button", { name: "Apply" }));
    expect(slateToMarkdown(reloaded.editor.children)).toContain(
      'query = "kind:NOTE"',
    );
    act(() => HistoryEditor.undo(reloaded.editor));
    expect(reloaded.editor.children[0]).toMatchObject({
      type: "search-embed",
      status: "configured",
      query: "water",
    });
  });

  it("cancels buffered edits with Escape and restores the edit control focus", async () => {
    const view = mount(source);
    await view.user.click(screen.getByRole("button", { name: "Edit search" }));
    await view.user.type(
      screen.getByRole("textbox", { name: "Query" }),
      " changed",
    );
    await view.user.keyboard("{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(slateToMarkdown(view.editor.children)).toBe(source);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit search" })).toHaveFocus(),
    );
  });

  it("preserves unknown source on cancel and requires explicit source repair", async () => {
    const raw = '~~~~search\r\nquery = "water"\r\nfuture = true\r\n~~~~';
    const view = mount(raw);
    await view.user.click(
      screen.getByRole("button", { name: "Repair search" }),
    );
    expect(screen.getByRole("textbox", { name: "Search TOML" })).toHaveValue(
      'query = "water"\nfuture = true',
    );
    await view.user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(slateToMarkdown(view.editor.children)).toBe(raw);
    await view.user.click(
      screen.getByRole("button", { name: "Repair search" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Search TOML" }), {
      target: { value: 'query = "water"\nlimit = 200' },
    });
    await view.user.click(screen.getByRole("button", { name: "Apply" }));
    expect(slateToMarkdown(view.editor.children)).toContain("limit = 200");
    expect(slateToMarkdown(view.editor.children)).not.toContain("future");
  });

  it("renders bounded safe snippets, opens the Folio, and refreshes after vault invalidation", async () => {
    results.push({
      page_id: "second",
      path: "notes/second.md",
      title: "Second result",
      snippet: "",
      rank: 0,
    });
    const view = mount(source);
    await view.user.click(
      await screen.findByRole("button", { name: "Water clock" }),
    );
    expect(transport.openTab).toHaveBeenCalledWith(
      "page",
      "notes/clock.md",
      "Water clock",
    );
    expect(
      screen.queryByRole("button", { name: "Second result" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("1 result shown · limit 1")).toBeVisible();
    expect(view.container.querySelector("img")).toBeNull();
    expect(screen.getByText(/Water mechanism <img/)).toBeVisible();
    results = [
      {
        page_id: "new",
        path: "notes/new.md",
        title: "Updated clock",
        snippet: "",
        rank: -1,
      },
    ];
    act(() => invalidatePageContent(view.client, "notes/new.md"));
    expect(
      await screen.findByRole("button", { name: "Updated clock" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Water clock" }),
    ).not.toBeInTheDocument();
  });

  it("validates result bounds without mutating the persisted search", async () => {
    const view = mount(source);
    await view.user.click(screen.getByRole("button", { name: "Edit search" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Result limit" }), {
      target: { value: "201" },
    });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("1 to 200");
    expect(slateToMarkdown(view.editor.children)).toBe(source);
  });

  it("keeps read-only results navigable without mutation controls", async () => {
    const view = mount(source, true);
    await view.user.click(
      await screen.findByRole("button", { name: "Water clock" }),
    );
    expect(transport.openTab).toHaveBeenCalledWith(
      "page",
      "notes/clock.md",
      "Water clock",
    );
    expect(
      screen.queryByRole("button", { name: "Edit search" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove search" }),
    ).not.toBeInTheDocument();
    expect(slateToMarkdown(view.editor.children)).toBe(source);
  });

  it("honors a protected host's embed mutation restriction", async () => {
    const view = mount(source, false, true);
    expect(
      await screen.findByRole("button", { name: "Water clock" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit search" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove search" }),
    ).not.toBeInTheDocument();
    expect(slateToMarkdown(view.editor.children)).toBe(source);
  });

  it("closes drafts without writing when the host goes offline and refreshes on reconnect", async () => {
    const view = mount(source);
    await view.user.click(screen.getByRole("button", { name: "Edit search" }));
    await view.user.type(
      screen.getByRole("textbox", { name: "Query" }),
      " unsaved",
    );
    act(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: false,
      });
      window.dispatchEvent(new Event("offline"));
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(screen.getByText(/unavailable offline/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Edit search" }),
    ).not.toBeInTheDocument();
    expect(slateToMarkdown(view.editor.children)).toBe(source);
    act(() => {
      Object.defineProperty(navigator, "onLine", {
        configurable: true,
        value: true,
      });
      window.dispatchEvent(new Event("online"));
    });
    expect(
      await screen.findByRole("button", { name: "Water clock" }),
    ).toBeVisible();
  });

  it("cancels a new slash insertion without retaining an empty search fence", async () => {
    const view = mount("Before\n\n/\n");
    const editable = view.container.querySelector<HTMLElement>(
      '[contenteditable="true"]',
    );
    if (!editable) throw new Error("Editable missing");
    await view.user.click(editable);
    act(() => Transforms.select(view.editor, { path: [1, 0], offset: 1 }));
    await view.user.type(editable, "search");
    fireEvent.mouseDown(
      await screen.findByRole("option", { name: /Search embed/ }),
    );
    await view.user.click(
      await screen.findByRole("button", { name: "Cancel" }),
    );
    expect(slateToMarkdown(view.editor.children)).not.toContain("```search");
    expect(editable).toHaveTextContent("Before");
    await waitFor(() => expect(editable).toHaveFocus());
  });

  it.each(["syntax", "network"] as const)(
    "distinguishes %s errors and only retries transport failures",
    async (kind) => {
      failure = kind;
      const view = mount(source);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        kind === "syntax" ? "Invalid search query" : "Search unavailable",
      );
      if (kind === "syntax") {
        expect(
          screen.queryByRole("button", { name: "Retry search" }),
        ).not.toBeInTheDocument();
      } else {
        failure = undefined;
        await view.user.click(
          screen.getByRole("button", { name: "Retry search" }),
        );
        expect(
          await screen.findByRole("button", { name: "Water clock" }),
        ).toBeVisible();
      }
    },
  );

  it("removes a search through its own control", async () => {
    const view = mount(`${source}\nAfter\n`);
    await view.user.click(
      screen.getByRole("button", { name: "Remove search" }),
    );
    expect(slateToMarkdown(view.editor.children)).toBe("After\n");
  });
});

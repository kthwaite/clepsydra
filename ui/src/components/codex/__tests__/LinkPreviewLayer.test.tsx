import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { shortFolio } from "#/components/codex/folio-utils";
import { LinkPreviewLayer } from "#/components/codex/LinkPreviewLayer";
import { usePreviewStore } from "#/store/preview";

const { pageState, projectionState, openTab, refetch } = vi.hoisted(() => ({
  pageState: {
    data: undefined as
      | {
          meta: { id: string; title: string; tags: string[] };
          body: string;
          encrypted?: boolean;
        }
      | undefined,
    isPending: false,
    isError: false,
    error: null as unknown,
  },
  projectionState: {
    data: undefined as
      | { preview: { fields: []; remaining_count: number } }
      | undefined,
    isPending: false,
    isError: false,
  },
  openTab: vi.fn(),
  refetch: vi.fn(),
}));
vi.mock("#/api/pages", () => ({ usePage: () => ({ ...pageState, refetch }) }));
vi.mock("#/api/bases", () => ({
  usePageBaseProperties: () => projectionState,
}));
vi.mock("#/api/index", () => ({
  useBacklinks: () => ({ data: [{}, {}] }),
  useOutlinks: () => ({
    data: [
      { kind: "wiki", target_raw: "Child", target_path: "notes/child.md" },
    ],
    refetch: vi.fn(),
  }),
}));
vi.mock("#/api/attachments", () => ({
  useAttachments: () => ({
    data: [{ vault_path: "media/diagram.png", path: "diagram.png" }],
  }),
  attachmentUrl: (path: string) => `/api/vault/attachments/${path}`,
}));
vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => openTab }));

const rect = new DOMRect(30, 40, 80, 20);
beforeEach(() => {
  localStorage.clear();
  usePreviewStore.setState({ windows: [], topZ: 200 });
  pageState.data = {
    meta: { id: "page-target", title: "Target", tags: ["history"] },
    body: `# Beginning\n\n${"Readable paragraph.\n\n".repeat(80)}Final paragraph.`,
  };
  pageState.isPending = false;
  pageState.isError = false;
  pageState.error = null;
  projectionState.isError = false;
  openTab.mockReset();
  refetch.mockReset();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("expands an excerpt into a selectable full reader while preserving metadata and navigation", async () => {
  usePreviewStore.getState().open({ path: "notes/target.md" }, rect);
  render(<LinkPreviewLayer />);
  expect(screen.getByRole("button", { name: "Expand preview" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));
  expect(await screen.findByText("Final paragraph.")).toBeVisible();
  expect(screen.getByText("#history")).toBeVisible();
  expect(screen.getByText(/2 backlinks/)).toBeVisible();
  expect(screen.getByRole("region", { name: "Reading Target" })).toHaveClass(
    "overflow-y-auto",
  );
  fireEvent.click(screen.getByRole("button", { name: "Open page" }));
  expect(openTab).toHaveBeenCalledWith("page", "notes/target.md", "Target", {});
  expect(usePreviewStore.getState().windows[0]?.mode).toBe("reader");
});

it("keeps an unpinned reader open and restores it from the tray", async () => {
  const id = usePreviewStore.getState().open({ path: "notes/target.md" }, rect);
  render(<LinkPreviewLayer />);
  fireEvent.click(screen.getByRole("button", { name: "Pin preview" }));
  await screen.findByText("Final paragraph.");
  fireEvent.click(screen.getByRole("button", { name: "Unpin preview" }));
  expect(usePreviewStore.getState().windows[0]).toMatchObject({
    id,
    mode: "reader",
    pinned: false,
  });
  expect(screen.getByRole("dialog", { name: "Preview Target" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Minimize preview" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", { name: shortFolio("notes/target.md") }),
  );
  expect(screen.getByRole("dialog", { name: "Preview Target" })).toBeVisible();
});

it("distinguishes loading, fetch failure, deleted page and protected content", () => {
  usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { mode: "reader" });
  pageState.data = undefined;
  pageState.isPending = true;
  const view = render(<LinkPreviewLayer />);
  expect(screen.getByText("Loading page…")).toBeVisible();
  pageState.isPending = false;
  pageState.isError = true;
  pageState.error = { status: 500 };
  view.rerender(<LinkPreviewLayer />);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Could not load this page.",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refetch).toHaveBeenCalledOnce();
  pageState.error = { status: 404 };
  view.rerender(<LinkPreviewLayer />);
  expect(screen.getByText(/moved or deleted/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  pageState.isError = false;
  pageState.data = {
    meta: { id: "locked", title: "Locked", tags: [] },
    body: "Secret decrypted content",
    encrypted: true,
  };
  view.rerender(<LinkPreviewLayer />);
  expect(screen.getByText("Protected note · open to unlock")).toBeVisible();
  expect(screen.queryByText("Secret decrypted content")).toBeNull();
});

it("preserves passage navigation and reports a missing passage honestly", async () => {
  usePreviewStore
    .getState()
    .open({ path: "notes/target.md", heading: "Absent section" }, rect, {
      mode: "reader",
    });
  render(<LinkPreviewLayer />);
  expect(
    await screen.findByText("The requested passage is missing from this page."),
  ).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Open page" }));
  expect(openTab).toHaveBeenCalledWith("page", "notes/target.md", "Target", {
    heading: "Absent section",
  });
  fireEvent.click(screen.getByRole("button", { name: "Show full page" }));
  expect(screen.getByText("Final paragraph.")).toBeVisible();
  expect(
    screen.queryByText("The requested passage is missing from this page."),
  ).toBeNull();
});

it("focuses explicit readers, restores their opener on Escape, and leaves hover focus alone", async () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const id = usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { opener });
  render(<LinkPreviewLayer />);
  expect(opener).toHaveFocus();
  act(() => usePreviewStore.getState().expand(id));
  expect(screen.getByRole("region", { name: "Reading Target" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape" });
  await waitFor(() => expect(opener).toHaveFocus());
  expect(screen.queryByRole("dialog")).toBeNull();
  opener.remove();
});

it("keeps parent content and scroll mounted while a narrow sheet explores a child", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const parentId = usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { mode: "reader" });
  render(<LinkPreviewLayer />);
  await screen.findByText("Final paragraph.");
  const parent = screen.getByRole("region", { name: "Reading Target" });
  parent.scrollTop = 350;
  act(() =>
    usePreviewStore
      .getState()
      .open({ path: "notes/child.md" }, rect, { mode: "reader", parentId }),
  );
  expect(parent).toBeInTheDocument();
  expect(parent).not.toBeVisible();
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(parent).toBeVisible();
  expect(parent.scrollTop).toBe(350);
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("resizes a reader with keyboard controls and keeps geometry within the viewport", () => {
  usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { mode: "reader" });
  render(<LinkPreviewLayer />);
  const resize = screen.getByRole("button", { name: "Resize preview" });
  const width = usePreviewStore.getState().windows[0]?.width ?? 0;
  fireEvent.keyDown(resize, { key: "ArrowRight" });
  expect(usePreviewStore.getState().windows[0]?.width).toBe(width + 10);
  for (let index = 0; index < 30; index++)
    fireEvent.keyDown(resize, { key: "ArrowRight", shiftKey: true });
  const win = usePreviewStore.getState().windows[0];
  expect((win?.x ?? 0) + (win?.width ?? 0)).toBeLessThanOrEqual(innerWidth);
});

it("retains projection failure feedback without replacing readable content", async () => {
  projectionState.isError = true;
  usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { mode: "reader" });
  render(<LinkPreviewLayer />);
  const reader = screen.getByRole("dialog", { name: "Preview Target" });
  expect(within(reader).getByText("Properties unavailable")).toBeVisible();
  expect(await within(reader).findByText("Final paragraph.")).toBeVisible();
});

it("follows internal reader links without navigating the workspace or resetting parent scroll", async () => {
  pageState.data = {
    meta: { id: "parent", title: "Parent", tags: [] },
    body: "[Child](/pages/notes%2Fchild.md#Details)",
  };
  const parentId = usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { mode: "reader" });
  render(<LinkPreviewLayer />);
  const link = await screen.findByRole("link", { name: "Child" });
  const parent = screen.getByRole("region", { name: "Reading Parent" });
  parent.scrollTop = 230;
  fireEvent.click(link);
  expect(usePreviewStore.getState().windows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        path: "notes/child.md",
        heading: "Details",
        mode: "reader",
        parentId,
      }),
    ]),
  );
  expect(openTab).not.toHaveBeenCalled();
  expect(parent.scrollTop).toBe(230);
});

it("leaves Escape handled by a deeper control alone", () => {
  usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { mode: "reader" });
  render(<LinkPreviewLayer />);
  const input = document.createElement("input");
  screen.getByRole("region", { name: "Reading Target" }).append(input);
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.getByRole("dialog", { name: "Preview Target" })).toBeVisible();
  input.remove();
});

it("renders local resources and keeps restricted reader descendants inert", async () => {
  pageState.data = {
    meta: { id: "parent", title: "Parent", tags: [] },
    body: "![Diagram](../media/diagram.png)\n\n[Child](/pages/notes%2Fchild.md)\n\n```mermaid\ngraph TD; A-->B;\n```",
  };
  usePreviewStore.getState().open({ path: "notes/target.md" }, rect, {
    mode: "reader",
    restricted: true,
  });
  render(<LinkPreviewLayer />);
  expect(await screen.findByRole("img", { name: "Diagram" })).toHaveAttribute(
    "src",
    "/api/vault/attachments/diagram.png",
  );
  expect(screen.getByText("graph TD; A-->B;")).toBeVisible();
  expect(screen.queryByTestId("mermaid-diagram")).toBeNull();
  fireEvent.click(screen.getByRole("link", { name: "Child" }));
  expect(
    usePreviewStore
      .getState()
      .windows.find((win) => win.path === "notes/child.md"),
  ).toMatchObject({ restricted: true });
});

it("closes a sheet reading stack without deleting an independent pinned reader", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const independent = usePreviewStore
    .getState()
    .open({ path: "notes/reference.md" }, rect, { mode: "reader" });
  usePreviewStore.getState().pin(independent);
  const parentId = usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { mode: "reader" });
  usePreviewStore
    .getState()
    .open({ path: "notes/child.md" }, rect, { mode: "reader", parentId });
  render(<LinkPreviewLayer />);
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(usePreviewStore.getState().windows.map((win) => win.id)).toEqual([
    independent,
  ]);
});

it("clamps pointer dragging and keeps a pinned reader persisted after release", () => {
  const id = usePreviewStore
    .getState()
    .open({ path: "notes/target.md" }, rect, { mode: "reader" });
  usePreviewStore.getState().pin(id);
  render(<LinkPreviewLayer />);
  const dialog = screen.getByRole("dialog", { name: "Preview Target" });
  const titlebar = within(dialog).getByText(
    shortFolio("notes/target.md"),
  ).parentElement;
  expect(titlebar).not.toBeNull();
  fireEvent.pointerDown(titlebar as HTMLElement, {
    button: 0,
    clientX: 40,
    clientY: 70,
  });
  fireEvent.pointerMove(window, { clientX: -800, clientY: -800 });
  fireEvent.pointerUp(window);
  const moved = usePreviewStore.getState().windows[0];
  expect(moved?.x).toBeGreaterThanOrEqual(0);
  expect(moved?.y).toBeGreaterThanOrEqual(0);
  expect(dialog).toHaveStyle({ left: `${moved?.x}px`, top: `${moved?.y}px` });
  expect(localStorage.getItem("clp.preview.pinned")).toContain(
    "notes/target.md",
  );
});

it("addresses the actual block without scrolling the originating page", async () => {
  pageState.data = {
    meta: { id: "blocks", title: "Blocks", tags: [] },
    body: "# Context\n\nBefore the reference.\n\nThe addressed block. ^abc123DEF0\n\nAfter the reference.",
  };
  const main = document.createElement("main");
  main.scrollTop = 17;
  document.body.append(main);
  const geometry = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      return new DOMRect(
        0,
        this.dataset.blockId ? 350 : "previewScroll" in this.dataset ? 100 : 0,
        400,
        "previewNotice" in this.dataset ? 40 : 200,
      );
    });
  const id = usePreviewStore
    .getState()
    .open({ path: "notes/target.md", blockId: "abc123DEF0" }, rect, {
      mode: "reader",
    });
  render(<LinkPreviewLayer />);
  expect(await screen.findByText("The addressed block.")).toBeVisible();
  expect(screen.queryByText(/requested passage is missing/)).toBeNull();
  const reader = screen.getByRole("region", { name: "Reading Blocks" });
  expect(reader.scrollTop).toBe(210);
  expect(main.scrollTop).toBe(17);
  reader.scrollTop = 520;
  act(() => usePreviewStore.getState().raise(id));
  expect(reader.scrollTop).toBe(520);
  fireEvent.click(screen.getByRole("button", { name: "Show full page" }));
  expect(reader.scrollTop).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Return to passage" }));
  expect(reader.scrollTop).toBe(520);
  geometry.mockRestore();
  main.remove();
});

it("hover-opens an indexed wikilink inside a reader without leaving its parent", async () => {
  pageState.data = {
    meta: { id: "parent", title: "Parent", tags: [] },
    body: "Follow [[Child]].",
  };
  const parentId = usePreviewStore
    .getState()
    .open({ path: "notes/parent.md" }, rect, { mode: "reader" });
  render(<LinkPreviewLayer />);
  const link = await screen.findByRole("link", { name: "Child" });
  expect(link).toHaveAttribute("href");
  vi.useFakeTimers();
  fireEvent.mouseEnter(link);
  act(() => vi.advanceTimersByTime(220));
  const child = usePreviewStore
    .getState()
    .windows.find((win) => win.path === "notes/child.md");
  expect(child).toMatchObject({ mode: "peek", parentId });
  expect(
    usePreviewStore.getState().windows.find((win) => win.id === parentId),
  ).toMatchObject({ mode: "reader" });
  expect(openTab).not.toHaveBeenCalled();
});

it("parks sheet readers when opening a page so the destination is accessible", () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const id = usePreviewStore
    .getState()
    .open({ path: "notes/target.md", heading: "Details" }, rect, {
      mode: "reader",
    });
  usePreviewStore.getState().pin(id);
  render(<LinkPreviewLayer />);
  fireEvent.click(screen.getByRole("button", { name: "Open page" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(usePreviewStore.getState().windows).toEqual([
    expect.objectContaining({ id, pinned: true, minimized: true }),
  ]);
  fireEvent.click(
    screen.getByRole("button", { name: shortFolio("notes/target.md") }),
  );
  expect(screen.getByRole("dialog")).toBeVisible();
});

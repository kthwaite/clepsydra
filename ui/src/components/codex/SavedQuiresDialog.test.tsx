import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedQuire } from "#/api/quires";
import { SavedQuiresDialog } from "#/components/codex/SavedQuiresDialog";
import { useUiStore } from "#/store/ui";
import {
  registerWorkspaceTransitionGuard,
  useWorkspaceStore,
} from "#/store/workspace";

const { fetchMock, NativeRequest } = await vi.hoisted(async () => {
  // Storage must exist before the persisted workspace module is imported.
  const { installMemoryStorage } = await import("#/test/memoryStorage");
  installMemoryStorage();
  const NativeRequest = globalThis.Request;
  class BrowserRequest extends NativeRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      super(
        typeof input === "string" ? new URL(input, "https://ui.test") : input,
        init,
      );
    }
  }
  const fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("Request", BrowserRequest);
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, NativeRequest };
});

vi.mock("#/hooks/useFolioHistoryNavigation", () => ({
  useOpenSavedQuireWithFolioHistory: () => (snapshot: SavedQuire) =>
    useWorkspaceStore.getState().openSavedQuire(snapshot),
}));

const saved: SavedQuire = {
  id: "saved-1",
  name: "Research",
  color: "ochre",
  revision: "revision-1",
  members: [
    { page_id: "page-a", path: "notes/a.md", label: "Alpha", missing: false },
  ],
};

function renderDialog() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <SavedQuiresDialog />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

beforeEach(() => {
  fetchMock.mockReset();
  useUiStore.setState({ savedQuireDialog: { kind: "save", quireId: "q1" } });
  useWorkspaceStore.setState({
    tabs: [
      {
        id: "tab-a",
        type: "page",
        pageId: "page-a",
        path: "notes/a.md",
        label: "Alpha",
        quireId: "q1",
      },
    ],
    activeTabId: "tab-a",
    quires: {
      q1: { id: "q1", name: "Research", color: "ochre", collapsed: false },
    },
  });
});

afterAll(() => {
  vi.stubGlobal("Request", NativeRequest);
  vi.unstubAllGlobals();
});

describe("saved quire actions", () => {
  it("saves an explicitly named ordered snapshot and links only after success", async () => {
    // The UI's ES2022 library target does not expose Promise.withResolvers.
    let finish!: (response: Response) => void;
    const promise = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    fetchMock.mockReturnValue(promise);
    const user = renderDialog();
    const name = screen.getByRole("textbox", { name: "Name" });
    await user.clear(name);
    await user.type(name, "Reading list");
    await user.click(screen.getByRole("button", { name: "Save quire" }));
    expect(useWorkspaceStore.getState().quires.q1.savedId).toBeUndefined();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    const request = fetchMock.mock.calls[0][0];
    expect(request).toBeInstanceOf(Request);
    if (!(request instanceof Request)) throw new Error("Expected HTTP request");
    expect(request.method).toBe("POST");
    expect(await request.json()).toEqual({
      name: "Reading list",
      color: "ochre",
      members: [{ page_id: "page-a", path: "notes/a.md", label: "Alpha" }],
    });
    finish(Response.json({ ...saved, name: "Reading list" }, { status: 201 }));
    await waitFor(() =>
      expect(useWorkspaceStore.getState().quires.q1.savedRevision).toBe(
        "revision-1",
      ),
    );
    expect(useUiStore.getState().savedQuireDialog).toBeNull();
  });
  it("fetches fresh membership and reports missing pages before opening available pages", async () => {
    useUiStore.setState({ savedQuireDialog: { kind: "picker" } });
    const fresh: SavedQuire = {
      ...saved,
      members: [
        {
          page_id: "page-a",
          path: "notes/moved.md",
          label: "Renamed Alpha",
          missing: false,
        },
        {
          page_id: "page-b",
          path: "notes/b.md",
          label: "Missing Beta",
          missing: true,
        },
      ],
    };
    fetchMock
      .mockResolvedValueOnce(Response.json([saved]))
      .mockResolvedValueOnce(Response.json(fresh));
    const user = renderDialog();
    expect(
      screen.getByText(/moved into this quire, not duplicated/),
    ).toBeVisible();
    await user.click(
      await screen.findByRole("button", { name: "Reopen Research" }),
    );
    expect(await screen.findByText("Missing Beta — notes/b.md")).toBeVisible();
    expect(useWorkspaceStore.getState().tabs[0].path).toBe("notes/a.md");
    await user.click(
      screen.getByRole("button", { name: "Open available pages" }),
    );
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
    expect(useWorkspaceStore.getState().tabs[0]).toMatchObject({
      id: "tab-a",
      path: "notes/moved.md",
    });
    const request = fetchMock.mock.calls[1][0];
    if (!(request instanceof Request)) throw new Error("Expected HTTP request");
    expect(new URL(request.url).pathname).toBe("/api/vault/quires/saved-1");
  });

  it("keeps all-missing snapshots from changing the workspace", async () => {
    useUiStore.setState({ savedQuireDialog: { kind: "picker" } });
    fetchMock
      .mockResolvedValueOnce(Response.json([saved]))
      .mockResolvedValueOnce(
        Response.json({
          ...saved,
          members: saved.members.map((member) => ({
            ...member,
            missing: true,
          })),
        }),
      );
    const user = renderDialog();
    await user.click(
      await screen.findByRole("button", { name: "Reopen Research" }),
    );
    expect(
      await screen.findByRole("button", { name: "Open available pages" }),
    ).toBeDisabled();
    expect(screen.getByText(/No pages are currently available/)).toBeVisible();
    expect(useWorkspaceStore.getState().tabs[0].id).toBe("tab-a");
  });

  it("warns before replacement and sends the linked revision, never a refreshed revision", async () => {
    useUiStore.setState({
      savedQuireDialog: { kind: "update", quireId: "q1" },
    });
    useWorkspaceStore
      .getState()
      .linkSavedQuire("q1", saved.id, "linked-revision");
    fetchMock.mockResolvedValue(
      Response.json({ ...saved, revision: "revision-2" }),
    );
    const user = renderDialog();
    expect(
      screen.getByText(/closed or unavailable will be removed/),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
    await user.click(
      screen.getByRole("button", { name: "Replace saved snapshot" }),
    );
    await waitFor(() =>
      expect(useWorkspaceStore.getState().quires.q1.savedRevision).toBe(
        "revision-2",
      ),
    );
    const request = fetchMock.mock.calls[0][0];
    if (!(request instanceof Request)) throw new Error("Expected HTTP request");
    expect(request.method).toBe("PUT");
    expect(await request.json()).toEqual({
      expected_revision: "linked-revision",
      name: "Research",
      color: "ochre",
      members: [{ page_id: "page-a", path: "notes/a.md", label: "Alpha" }],
    });
  });

  it("does not overwrite or advance the link on a stale update", async () => {
    useUiStore.setState({
      savedQuireDialog: { kind: "update", quireId: "q1" },
    });
    useWorkspaceStore
      .getState()
      .linkSavedQuire("q1", saved.id, "stale-revision");
    fetchMock.mockResolvedValue(
      Response.json({ error: "Saved quire changed" }, { status: 409 }),
    );
    const user = renderDialog();
    await user.click(
      screen.getByRole("button", { name: "Replace saved snapshot" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nothing was overwritten",
    );
    expect(useWorkspaceStore.getState().quires.q1.savedRevision).toBe(
      "stale-revision",
    );
    expect(
      screen.getByRole("button", { name: "Replace saved snapshot" }),
    ).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useUiStore.getState().savedQuireDialog).toBeNull();
  });

  it("renames with the displayed revision while preserving saved membership", async () => {
    useUiStore.setState({ savedQuireDialog: { kind: "picker" } });
    fetchMock
      .mockResolvedValueOnce(Response.json([saved]))
      .mockResolvedValueOnce(
        Response.json({ ...saved, name: "Renamed", revision: "revision-2" }),
      )
      .mockImplementation(async () =>
        Response.json([{ ...saved, name: "Renamed", revision: "revision-2" }]),
      );
    const user = renderDialog();
    await user.click(
      await screen.findByRole("button", { name: "Rename Research" }),
    );
    await user.clear(screen.getByRole("textbox", { name: "Name" }));
    await user.type(screen.getByRole("textbox", { name: "Name" }), "Renamed");
    await user.click(
      screen.getByRole("button", { name: "Rename saved quire" }),
    );
    expect(
      await screen.findByRole("button", { name: "Reopen Renamed" }),
    ).toBeVisible();
    const request = fetchMock.mock.calls[1][0];
    if (!(request instanceof Request)) throw new Error("Expected HTTP request");
    expect(await request.json()).toEqual({
      expected_revision: "revision-1",
      name: "Renamed",
      color: "ochre",
    });
  });

  it("confirms deletion and keeps pages and local groups", async () => {
    useUiStore.setState({ savedQuireDialog: { kind: "picker" } });
    useWorkspaceStore.getState().linkSavedQuire("q1", saved.id, saved.revision);
    fetchMock
      .mockResolvedValueOnce(Response.json([saved]))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockImplementation(async () => Response.json([]));
    const user = renderDialog();
    await user.click(
      await screen.findByRole("button", { name: "Delete Research" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/pages and open tabs will be kept/)).toBeVisible();
    await user.click(
      screen.getByRole("button", { name: "Delete saved quire" }),
    );
    await waitFor(() =>
      expect(useWorkspaceStore.getState().quires.q1.savedId).toBeUndefined(),
    );
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
    expect(useWorkspaceStore.getState().tabs[0].quireId).toBe("q1");
    const request = fetchMock.mock.calls[1][0];
    if (!(request instanceof Request)) throw new Error("Expected HTTP request");
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).searchParams.get("expected_revision")).toBe(
      "revision-1",
    );
  });

  it("keeps the chosen name and permits retry after a failed save", async () => {
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ error: "Disk unavailable" }, { status: 500 }),
      )
      .mockResolvedValueOnce(Response.json(saved, { status: 201 }));
    const user = renderDialog();
    await user.click(screen.getByRole("button", { name: "Save quire" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Disk unavailable",
    );
    expect(screen.getByRole("textbox", { name: "Name" })).toHaveValue(
      "Research",
    );
    expect(useWorkspaceStore.getState().quires.q1.savedId).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Save quire" }));
    await waitFor(() =>
      expect(useWorkspaceStore.getState().quires.q1.savedId).toBe(saved.id),
    );
  });

  it("keeps the picker usable after a failed fresh read without opening stale members", async () => {
    useUiStore.setState({ savedQuireDialog: { kind: "picker" } });
    fetchMock
      .mockResolvedValueOnce(Response.json([saved]))
      .mockResolvedValueOnce(
        Response.json({ error: "Unavailable" }, { status: 500 }),
      );
    const user = renderDialog();
    await user.click(
      await screen.findByRole("button", { name: "Reopen Research" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Unavailable");
    expect(
      screen.getByRole("button", { name: "Reopen Research" }),
    ).toBeEnabled();
    expect(useWorkspaceStore.getState().tabs[0].quireId).toBe("q1");
  });

  it("retains the local link and asks for reload after a stale delete", async () => {
    useUiStore.setState({ savedQuireDialog: { kind: "picker" } });
    useWorkspaceStore.getState().linkSavedQuire("q1", saved.id, saved.revision);
    fetchMock
      .mockResolvedValueOnce(Response.json([saved]))
      .mockResolvedValueOnce(
        Response.json({ error: "Snapshot changed" }, { status: 409 }),
      );
    const user = renderDialog();
    await user.click(
      await screen.findByRole("button", { name: "Delete Research" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Delete saved quire" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Nothing was overwritten",
    );
    expect(
      screen.getByRole("button", { name: "Delete saved quire" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Reload saved quires" }),
    ).toBeEnabled();
    expect(useWorkspaceStore.getState().quires.q1.savedRevision).toBe(
      "revision-1",
    );
    expect(useWorkspaceStore.getState().tabs).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps the picker and workspace intact when the unsaved-edit guard cancels reopen", async () => {
    useUiStore.setState({ savedQuireDialog: { kind: "picker" } });
    fetchMock
      .mockResolvedValueOnce(Response.json([saved]))
      .mockResolvedValueOnce(Response.json(saved));
    const user = renderDialog();
    await user.click(
      await screen.findByRole("button", { name: "Reopen Research" }),
    );
    const open = await screen.findByRole("button", {
      name: "Open available pages",
    });
    const unregister = registerWorkspaceTransitionGuard(() => true);
    try {
      await user.click(open);
      expect(useUiStore.getState().savedQuireDialog).toEqual({
        kind: "picker",
      });
      expect(useWorkspaceStore.getState().quires.q1.savedId).toBeUndefined();
      expect(open).toBeVisible();
    } finally {
      unregister();
    }
  });

  it("offers retry when the collection list cannot load", async () => {
    useUiStore.setState({ savedQuireDialog: { kind: "picker" } });
    fetchMock
      .mockResolvedValueOnce(
        Response.json({ error: "Offline" }, { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json([]));
    const user = renderDialog();
    expect(await screen.findByRole("alert")).toHaveTextContent("Offline");
    await user.click(
      screen.getByRole("button", { name: "Reload saved quires" }),
    );
    expect(await screen.findByText(/No saved quires yet/)).toBeVisible();
  });
});

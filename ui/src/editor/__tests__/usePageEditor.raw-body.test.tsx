import { act, renderHook, waitFor } from "@testing-library/react";
import type { Descendant, Editor } from "slate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ConvertModule from "../convert";
import { usePageEditor } from "../usePageEditor";

const {
  decryptMarkdownMock,
  encryptMarkdownMock,
  encryptionActions,
  encryptionState,
  getIdentityMock,
  markdownToSlateMock,
  mutateAsyncMock,
  recipientForIdentityMock,
  refetchPageMock,
  registerFlusherMock,
  usePageMock,
  useUpdatePageMock,
} = vi.hoisted(() => {
  const getIdentityMock = vi.fn<() => string | null>();
  const registerFlusherMock = vi.fn();
  return {
    decryptMarkdownMock: vi.fn(),
    encryptMarkdownMock: vi.fn(),
    encryptionActions: {
      getIdentity: getIdentityMock,
      registerFlusher: registerFlusherMock,
    },
    encryptionState: {
      value: {
        status: "unlocked" as "loading" | "locked" | "unlocked",
        keyId: "019fd000-0000-7000-8000-000000000504" as string | null,
        error: null as string | null,
        lockEpoch: 0,
      },
    },
    getIdentityMock,
    markdownToSlateMock: vi.fn(),
    mutateAsyncMock: vi.fn(),
    recipientForIdentityMock: vi.fn(),
    refetchPageMock: vi.fn(),
    registerFlusherMock,
    usePageMock: vi.fn(),
    useUpdatePageMock: vi.fn(),
  };
});

vi.mock("#/api/pages", () => ({
  usePage: usePageMock,
  useUpdatePage: useUpdatePageMock,
}));

vi.mock("#/crypto/EncryptionProvider", () => ({
  useOptionalEncryptionActions: () => encryptionActions,
  useOptionalEncryptionStatus: () => encryptionState.value,
}));

vi.mock("#/crypto/age", () => ({
  decryptMarkdown: decryptMarkdownMock,
  encryptMarkdown: encryptMarkdownMock,
  recipientForIdentity: recipientForIdentityMock,
}));

vi.mock("../convert", async (importOriginal) => {
  const actual = await importOriginal<typeof ConvertModule>();
  markdownToSlateMock.mockImplementation(actual.markdownToSlate);
  return {
    ...actual,
    markdownToSlate: markdownToSlateMock,
  };
});

interface MockPage {
  path: string;
  canonical_name: string;
  body: string;
  revision: string;
  kind: "NOTE";
  inferred: boolean;
  project: null;
  encrypted: boolean;
  encryption: { format: "age"; key_id: string } | null;
  meta: {
    id: string;
    title: string | null;
    tags: string[];
    aliases: string[];
    created_at: null;
    updated_at: null;
  };
}

interface UpdateRequest {
  params: { path: { path: string } };
  body: Record<string, unknown>;
}
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}


function makePage(
  body: string,
  revision = "rev-a",
  path = "notes/page.md",
  encrypted = false,
): MockPage {
  return {
    path,
    canonical_name: path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
    body,
    revision,
    kind: "NOTE",
    inferred: true,
    project: null,
    encrypted,
    encryption: encrypted
      ? {
          format: "age",
          key_id: "019fd000-0000-7000-8000-000000000504",
        }
      : null,
    meta: {
      id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62",
      title: null,
      tags: [],
      aliases: [],
      created_at: null,
      updated_at: null,
    },
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function revisionConflict(currentRevision = "rev-b") {
  return {
    status: 409,
    error: "page changed since it was loaded",
    detail: {
      code: "revision_conflict",
      current_revision: currentRevision,
    },
    hint: null,
  };
}

const RAW_BODY = "INGREDIENTS\n• stock\n\nSTEPS\n1. Simmer.\n\nNOTES\n";

describe("usePageEditor raw Markdown body", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    encryptionState.value = {
      status: "unlocked",
      keyId: "019fd000-0000-7000-8000-000000000504",
      error: null,
      lockEpoch: 0,
    };
    getIdentityMock.mockReturnValue("AGE-SECRET-KEY-TEST");
    recipientForIdentityMock.mockResolvedValue("age1testrecipient");
    registerFlusherMock.mockReturnValue(vi.fn());
    decryptMarkdownMock.mockResolvedValue("old\n");
    const page = makePage("old\n");
    usePageMock.mockReturnValue({
      data: page,
      isLoading: false,
      error: null,
      refetch: refetchPageMock,
    });
    refetchPageMock.mockResolvedValue({ data: page });
    useUpdatePageMock.mockReturnValue({ mutateAsync: mutateAsyncMock });
  });

  it("saves exact supplied Markdown and exposes it while the request is in flight", async () => {
    const save = deferred<MockPage>();
    mutateAsyncMock.mockReturnValue(save.promise);
    const { result } = renderHook(() => usePageEditor("notes/page.md"));

    act(() => {
      result.current.setBodyMarkdown(RAW_BODY);
    });
    expect(result.current.getPlaintext()).toBe(RAW_BODY);

    let savePromise!: Promise<void>;
    act(() => {
      savePromise = result.current.saveNow();
    });

    expect(mutateAsyncMock).toHaveBeenCalledWith({
      params: { path: { path: "notes/page.md" } },
      body: {
        expected_revision: "rev-a",
        body: RAW_BODY,
      },
    });
    expect(result.current.getPlaintext()).toBe(RAW_BODY);

    await act(async () => {
      save.resolve(makePage(RAW_BODY, "rev-b"));
      await savePromise;
    });
  });

  it("keeps the previously authored body as the save source when conversion fails", async () => {
    const authoredBody = "previously authored body\n";
    const failedRawBody = "failed raw body must not persist";
    mutateAsyncMock.mockImplementation(async (request: UpdateRequest) =>
      makePage(request.body.body as string, "rev-b"),
    );
    const { result } = renderHook(() => usePageEditor("notes/page.md"));

    act(() => result.current.setBodyMarkdown(authoredBody));
    markdownToSlateMock.mockImplementationOnce(() => {
      throw new Error("Markdown conversion failed");
    });

    expect(() => {
      act(() => result.current.setBodyMarkdown(failedRawBody));
    }).toThrow("Markdown conversion failed");
    expect(result.current.getPlaintext()).toBe(authoredBody);

    await act(async () => {
      await result.current.saveNow();
    });

    expect(mutateAsyncMock).toHaveBeenCalledOnce();
    expect(mutateAsyncMock.mock.calls[0]?.[0].body.body).toBe(authoredBody);
    expect(mutateAsyncMock.mock.calls[0]?.[0].body.body).not.toBe(failedRawBody);
  });

  it("queues a newer exact body written during an in-flight save", async () => {
    const pending: Array<{
      request: UpdateRequest;
      save: Deferred<MockPage>;
    }> = [];
    mutateAsyncMock.mockImplementation((request: UpdateRequest) => {
      const save = deferred<MockPage>();
      pending.push({ request, save });
      return save.promise;
    });
    const { result } = renderHook(() => usePageEditor("notes/page.md"));

    act(() => result.current.setBodyMarkdown("first body without normalization"));
    let firstFlight!: Promise<void>;
    act(() => {
      firstFlight = result.current.saveNow();
    });
    expect(pending).toHaveLength(1);

    act(() => result.current.setBodyMarkdown("second body\n\n"));
    const queuedFlight = result.current.saveNow();
    expect(queuedFlight).toBe(firstFlight);
    expect(result.current.getPlaintext()).toBe("second body\n\n");

    await act(async () => {
      pending[0].save.resolve(
        makePage("first body without normalization", "rev-b"),
      );
      await Promise.resolve();
    });

    expect(pending).toHaveLength(2);
    expect(pending[0].request.body.body).toBe(
      "first body without normalization",
    );
    expect(pending[1].request.body).toEqual({
      expected_revision: "rev-b",
      body: "second body\n\n",
    });

    await act(async () => {
      pending[1].save.resolve(makePage("second body\n\n", "rev-c"));
      await queuedFlight;
    });
    expect(result.current.saveStatus).toBe("saved");
  });

  it("falls back to serializing Slate after a subsequent Slate edit", async () => {
    mutateAsyncMock.mockImplementation(async (request: UpdateRequest) =>
      makePage(request.body.body as string, "rev-b"),
    );
    const { result } = renderHook(() => usePageEditor("notes/page.md"));

    act(() => result.current.setBodyMarkdown(RAW_BODY));
    act(() =>
      result.current.onSlateChange(
        [{ type: "paragraph", children: [{ text: "Slate wins" }] }] as Descendant[],
        {
          operations: [
            { type: "insert_text", path: [0, 0], offset: 0, text: "x" },
          ],
        } as unknown as Editor,
      ),
    );
    await act(async () => {
      await result.current.saveNow();
    });

    expect(mutateAsyncMock.mock.calls[0]?.[0].body.body).toBe("Slate wins\n");
    expect(result.current.getPlaintext()).toBe("Slate wins\n");
  });

  it("adopts server Markdown and discards the override after conflict reload", async () => {
    mutateAsyncMock.mockRejectedValue(revisionConflict());
    const latest = makePage("server body\n", "rev-b");
    refetchPageMock.mockResolvedValue({ data: latest });
    const { result } = renderHook(() => usePageEditor("notes/page.md"));

    act(() => result.current.setBodyMarkdown(RAW_BODY));
    await act(async () => {
      await expect(result.current.saveNow()).rejects.toMatchObject({
        detail: { code: "revision_conflict" },
      });
    });
    expect(result.current.getPlaintext()).toBe(RAW_BODY);

    await act(async () => {
      await result.current.reloadAfterConflict();
    });

    expect(result.current.revisionConflict).toBeNull();
    expect(result.current.getPlaintext()).toBe("server body\n");
  });

  it("ignores a conflict reload that resolves after navigation", async () => {
    const pageAPath = "notes/page-a.md";
    const pageBPath = "notes/page-b.md";
    const pageA = makePage("page A\n", "a-rev-a", pageAPath);
    const pageB = makePage("page B\n", "b-rev-a", pageBPath);
    const reload = deferred<{ data: MockPage }>();
    usePageMock.mockImplementation((path: string) => ({
      data: path === pageAPath ? pageA : pageB,
      isLoading: false,
      error: null,
      refetch: refetchPageMock,
    }));
    refetchPageMock.mockReturnValue(reload.promise);
    mutateAsyncMock
      .mockRejectedValueOnce(revisionConflict("a-rev-b"))
      .mockImplementation(async (request: UpdateRequest) =>
        makePage(
          request.body.body as string,
          "b-rev-b",
          request.params.path.path,
        ),
      );
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => usePageEditor(path),
      { initialProps: { path: pageAPath } },
    );

    act(() => result.current.setBodyMarkdown("local page A\n"));
    await act(async () => {
      await expect(result.current.saveNow()).rejects.toMatchObject({
        detail: { code: "revision_conflict" },
      });
    });

    let reloadPromise!: Promise<void>;
    act(() => {
      reloadPromise = result.current.reloadAfterConflict();
    });
    expect(refetchPageMock).toHaveBeenCalledOnce();

    rerender({ path: pageBPath });
    act(() => result.current.setBodyMarkdown("local page B exact"));
    expect(result.current.getPlaintext()).toBe("local page B exact");
    expect(result.current.getRevision()).toBe("b-rev-a");

    await act(async () => {
      reload.resolve({
        data: makePage("server page A\n", "a-rev-b", pageAPath),
      });
      await reloadPromise;
    });

    expect(result.current.getPlaintext()).toBe("local page B exact");
    expect(result.current.getRevision()).toBe("b-rev-a");
    expect(result.current.saveStatus).toBe("unsaved");

    await act(async () => {
      await result.current.saveNow();
    });
    expect(mutateAsyncMock.mock.calls[1]?.[0]).toEqual({
      params: { path: { path: pageBPath } },
      body: {
        expected_revision: "b-rev-a",
        body: "local page B exact",
      },
    });
    expect(result.current.getPlaintext()).toBe("local page B exact");
    expect(result.current.getRevision()).toBe("b-rev-b");
  });

  it("never drains an outgoing raw body into the page selected next", async () => {
    const oldPath = "notes/old.md";
    const newPath = "notes/new.md";
    const oldPage = makePage("old page\n", "old-rev-a", oldPath);
    const newPage = makePage("new page\n", "new-rev-a", newPath);
    usePageMock.mockImplementation((path: string) => ({
      data: path === oldPath ? oldPage : newPage,
      isLoading: false,
      error: null,
      refetch: refetchPageMock,
    }));
    mutateAsyncMock.mockImplementation(async (request: UpdateRequest) => {
      if (request.params.path.path === oldPath) {
        return makePage(request.body.body as string, "old-rev-b", oldPath);
      }
      return {
        ...newPage,
        revision: "new-rev-b",
        meta: { ...newPage.meta, title: request.body.title as string },
      };
    });
    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => usePageEditor(path),
      { initialProps: { path: oldPath } },
    );

    act(() => result.current.setBodyMarkdown("outgoing exact body"));
    rerender({ path: newPath });
    expect(result.current.getPlaintext()).toBe("new page\n");

    act(() => result.current.setTitle("New page title"));
    await act(async () => {
      await result.current.saveNow();
    });

    const outgoingRequest = mutateAsyncMock.mock.calls.find(
      ([request]) => request.params.path.path === oldPath,
    )?.[0] as UpdateRequest | undefined;
    const newPageRequest = mutateAsyncMock.mock.calls.find(
      ([request]) => request.params.path.path === newPath,
    )?.[0] as UpdateRequest | undefined;
    expect(outgoingRequest?.body.body).toBe("outgoing exact body");
    expect(newPageRequest?.body).toEqual({
      expected_revision: "new-rev-a",
      title: "New page title",
    });
    expect(JSON.stringify(newPageRequest)).not.toContain("outgoing exact body");
  });

  it("encrypts the exact override through the existing protected save path", async () => {
    const encryptedPage = makePage("ciphertext-old", "rev-a", undefined, true);
    usePageMock.mockReturnValue({
      data: encryptedPage,
      isLoading: false,
      error: null,
      refetch: refetchPageMock,
    });
    encryptMarkdownMock.mockResolvedValue("ciphertext-new");
    mutateAsyncMock.mockResolvedValue(
      makePage("ciphertext-new", "rev-b", undefined, true),
    );
    const { result } = renderHook(() => usePageEditor("notes/page.md"));
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );

    act(() => result.current.setBodyMarkdown(RAW_BODY));
    await act(async () => {
      await result.current.saveNow();
    });

    expect(recipientForIdentityMock).toHaveBeenCalledWith(
      "AGE-SECRET-KEY-TEST",
    );
    expect(encryptMarkdownMock).toHaveBeenCalledWith(
      RAW_BODY,
      "age1testrecipient",
    );
    expect(mutateAsyncMock.mock.calls[0]?.[0].body).toEqual({
      expected_revision: "rev-a",
      body: "ciphertext-new",
    });
    expect(JSON.stringify(mutateAsyncMock.mock.calls[0]?.[0])).not.toContain(
      RAW_BODY,
    );
  });
});

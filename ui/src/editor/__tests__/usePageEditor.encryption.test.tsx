import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import type { Descendant, Editor } from "slate";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBoardStore } from "#/store/board";
import { useWorkspaceStore } from "#/store/workspace";
import { usePageEditor } from "../usePageEditor";

const {
  decryptMarkdownMock,
  encryptMarkdownMock,
  getIdentityMock,
  markdownToSlateMock,
  recipientForIdentityMock,
  registerFlusherMock,
  usePageMock,
  useUpdatePageMock,
  encryptionState,
} = vi.hoisted(() => ({
  decryptMarkdownMock: vi.fn(),
  encryptMarkdownMock: vi.fn(),
  getIdentityMock: vi.fn<() => string | null>(),
  markdownToSlateMock: vi.fn((body: string) => [
    { type: "paragraph", children: [{ text: body }] },
  ]),
  recipientForIdentityMock: vi.fn(),
  registerFlusherMock: vi.fn(),
  usePageMock: vi.fn(),
  useUpdatePageMock: vi.fn(),
  encryptionState: {
    value: {
      status: "locked" as "loading" | "locked" | "unlocked",
      keyId: "019fd000-0000-7000-8000-000000000504" as string | null,
      error: null as string | null,
      lockEpoch: 0,
    },
  },
}));

vi.mock("#/api/pages", () => ({
  usePage: usePageMock,
  useUpdatePage: useUpdatePageMock,
}));

vi.mock("#/crypto/EncryptionProvider", () => {
  const actions = {
    getIdentity: getIdentityMock,
    registerFlusher: registerFlusherMock,
  };
  return {
    useOptionalEncryptionActions: () => actions,
    useOptionalEncryptionStatus: () => encryptionState.value,
  };
});

vi.mock("#/crypto/age", () => ({
  decryptMarkdown: decryptMarkdownMock,
  encryptMarkdown: encryptMarkdownMock,
  recipientForIdentity: recipientForIdentityMock,
}));

vi.mock("../convert", () => ({
  markdownToSlate: markdownToSlateMock,
  slateToMarkdown: vi.fn(
    (value: Array<{ children?: Array<{ text?: string }> }>) =>
      `${value[0]?.children?.[0]?.text ?? ""}\n`,
  ),
}));

const ARMOR_A = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRlZC1ib2R5LWE=
-----END AGE ENCRYPTED FILE-----`;
const ARMOR_B = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRlZC1ib2R5LWI=
-----END AGE ENCRYPTED FILE-----`;
const KNOWN_SECRET = "CLEPSYDRA_UI_SECRET_4a2ec791_日本語_🔐";

function persistedBrowserState(): string {
  return JSON.stringify({
    localStorage: Array.from({ length: window.localStorage.length }, (_, index) => {
      const key = window.localStorage.key(index);
      return key === null ? null : [key, window.localStorage.getItem(key)];
    }),
    sessionStorage: Array.from(
      { length: window.sessionStorage.length },
      (_, index) => {
        const key = window.sessionStorage.key(index);
        return key === null ? null : [key, window.sessionStorage.getItem(key)];
      },
    ),
    workspace: useWorkspaceStore.getState(),
    board: useBoardStore.getState(),
  });
}

function makePage(
  path = "notes/protected-a.md",
  body = ARMOR_A,
  revision = "rev-a",
) {
  return {
    path,
    canonical_name: path.split("/").at(-1)?.replace(/\.md$/, "") ?? path,
    body,
    encrypted: true,
    encryption: {
      format: "age" as const,
      key_id: "019fd000-0000-7000-8000-000000000504",
    },
    revision,
    kind: "NOTE" as const,
    inferred: true,
    project: null,
    meta: {
      id: "019fc7fc-5ceb-7cd1-a312-e03266ff3f62",
      title: "Protected note",
      tags: ["private"],
      aliases: [],
      created_at: null,
      updated_at: null,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function paragraph(text: string): Descendant[] {
  return [{ type: "paragraph", children: [{ text }] }] as Descendant[];
}

function astChangeEditor(): Editor {
  return {
    operations: [{ type: "insert_text", path: [0, 0], offset: 0, text: "x" }],
  } as unknown as Editor;
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

describe("usePageEditor encrypted loads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    encryptionState.value = {
      status: "locked",
      keyId: "019fd000-0000-7000-8000-000000000504",
      error: null,
      lockEpoch: 0,
    };
    getIdentityMock.mockReturnValue(null);
    recipientForIdentityMock.mockResolvedValue("age1testrecipient");
    registerFlusherMock.mockReturnValue(vi.fn());
    const page = makePage();
    usePageMock.mockImplementation((path: string) => ({
      data: path === page.path ? page : { ...page, path },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }));
    useUpdatePageMock.mockReturnValue({ mutateAsync: vi.fn() });
  });

  it("returns a locked state without parsing ciphertext", () => {
    const { result } = renderHook(() => usePageEditor("notes/protected-a.md"));

    expect(result.current.encryptionState).toEqual({ status: "locked" });
    expect(markdownToSlateMock).not.toHaveBeenCalled();
    expect(decryptMarkdownMock).not.toHaveBeenCalled();
  });

  it("decrypts once per mounted revision and never writes plaintext to the query cache", async () => {
    const setQueryData = vi.spyOn(QueryClient.prototype, "setQueryData");
    decryptMarkdownMock.mockResolvedValue("# mounted plaintext");
    getIdentityMock.mockReturnValue("AGE-SECRET-KEY-TEST");
    encryptionState.value = {
      ...encryptionState.value,
      status: "unlocked",
    };

    const { result, rerender } = renderHook(() =>
      usePageEditor("notes/protected-a.md"),
    );

    await waitFor(() =>
      expect(result.current.encryptionState).toEqual({
        status: "plain",
        body: "# mounted plaintext",
      }),
    );
    expect(decryptMarkdownMock).toHaveBeenCalledOnce();
    expect(decryptMarkdownMock).toHaveBeenCalledWith(
      ARMOR_A,
      "AGE-SECRET-KEY-TEST",
    );
    expect(markdownToSlateMock).toHaveBeenCalledWith("# mounted plaintext");

    rerender();
    expect(decryptMarkdownMock).toHaveBeenCalledOnce();
    expect(
      setQueryData.mock.calls.some((call) =>
        JSON.stringify(call).includes("# mounted plaintext"),
      ),
    ).toBe(false);
    setQueryData.mockRestore();
  });

  it("ignores a stale load after switching paths during decryption", async () => {
    const first = deferred<string>();
    const second = deferred<string>();
    decryptMarkdownMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    getIdentityMock.mockReturnValue("AGE-SECRET-KEY-TEST");
    encryptionState.value = {
      ...encryptionState.value,
      status: "unlocked",
    };
    const firstPage = makePage("notes/protected-a.md", ARMOR_A, "rev-a");
    const secondPage = makePage("notes/protected-b.md", ARMOR_B, "rev-b");
    usePageMock.mockImplementation((path: string) => ({
      data: path === "notes/protected-a.md" ? firstPage : secondPage,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }));

    const { result, rerender } = renderHook(
      ({ path }: { path: string }) => usePageEditor(path),
      { initialProps: { path: "notes/protected-a.md" } },
    );
    await waitFor(() => expect(decryptMarkdownMock).toHaveBeenCalledOnce());

    rerender({ path: "notes/protected-b.md" });
    await waitFor(() => expect(decryptMarkdownMock).toHaveBeenCalledTimes(2));
    await act(async () => first.resolve("stale plaintext"));
    expect(result.current.encryptionState.status).toBe("decrypting");
    expect(markdownToSlateMock).not.toHaveBeenCalledWith("stale plaintext");

    await act(async () => second.resolve("current plaintext"));
    await waitFor(() =>
      expect(result.current.encryptionState).toEqual({
        status: "plain",
        body: "current plaintext",
      }),
    );
  });

  it("clears and remounts the editor when the session locks", async () => {
    decryptMarkdownMock.mockResolvedValue("secret plaintext");
    getIdentityMock.mockReturnValue("AGE-SECRET-KEY-TEST");
    encryptionState.value = {
      ...encryptionState.value,
      status: "unlocked",
    };
    const { result, rerender } = renderHook(() =>
      usePageEditor("notes/protected-a.md"),
    );
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    const unlockedRevision = result.current.editorRevision;

    getIdentityMock.mockReturnValue(null);
    encryptionState.value = {
      ...encryptionState.value,
      status: "locked",
      lockEpoch: 1,
    };
    rerender();

    await waitFor(() =>
      expect(result.current.encryptionState).toEqual({ status: "locked" }),
    );
    expect(result.current.editorRevision).toBeGreaterThan(unlockedRevision);
    expect(result.current.bodyMarkdown).toBe("");
  });

  it("shows an authentication error for a tampered body and never parses a blank note", async () => {
    decryptMarkdownMock.mockRejectedValue(new Error("SENSITIVE CRYPTO DETAIL"));
    getIdentityMock.mockReturnValue("AGE-SECRET-KEY-TEST");
    encryptionState.value = {
      ...encryptionState.value,
      status: "unlocked",
    };

    const { result } = renderHook(() => usePageEditor("notes/protected-a.md"));
    await waitFor(() =>
      expect(result.current.encryptionState).toEqual({
        status: "error",
        error: "Unable to authenticate encrypted note.",
      }),
    );
    expect(markdownToSlateMock).not.toHaveBeenCalled();
    expect(JSON.stringify(result.current)).not.toContain(
      "SENSITIVE CRYPTO DETAIL",
    );
  });

  it("deduplicates the visible StrictMode decrypt load", async () => {
    decryptMarkdownMock.mockResolvedValue("strict plaintext");
    getIdentityMock.mockReturnValue("AGE-SECRET-KEY-TEST");
    encryptionState.value = {
      ...encryptionState.value,
      status: "unlocked",
    };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>{children}</StrictMode>
    );

    const { result } = renderHook(() => usePageEditor("notes/protected-a.md"), {
      wrapper,
    });
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    expect(decryptMarkdownMock).toHaveBeenCalledOnce();
  });
});

describe("usePageEditor encrypted saves", () => {
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
    decryptMarkdownMock.mockResolvedValue("initial plaintext\n");
    const page = makePage();
    usePageMock.mockReturnValue({
      data: page,
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("encrypts a body save without leaking plaintext to requests or persisted UI state", async () => {
    const actualAge =
      await vi.importActual<typeof import("#/crypto/age")>("#/crypto/age");
    const vault = await actualAge.createVaultIdentity();
    getIdentityMock.mockReturnValue(vault.identity);
    recipientForIdentityMock.mockImplementation(actualAge.recipientForIdentity);
    encryptMarkdownMock.mockImplementation(actualAge.encryptMarkdown);
    const mutateAsync = vi.fn(async (request) => ({
      ...makePage(),
      body: request.body.body,
      revision: "rev-b",
    }));
    useUpdatePageMock.mockReturnValue({ mutateAsync });

    const { result, rerender } = renderHook(() =>
      usePageEditor("notes/protected-a.md"),
    );
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    act(() =>
      result.current.onSlateChange(
        paragraph(KNOWN_SECRET),
        astChangeEditor(),
      ),
    );

    await act(async () => {
      await result.current.saveNow();
    });

    const request = mutateAsync.mock.calls[0]?.[0];
    const sentBody = request.body.body as string;
    expect(sentBody).toMatch(/^-----BEGIN AGE ENCRYPTED FILE-----/);
    expect(sentBody).toMatch(/-----END AGE ENCRYPTED FILE-----\n$/);
    expect(JSON.stringify(request)).not.toContain(KNOWN_SECRET);
    await expect(
      actualAge.decryptMarkdown(sentBody, vault.identity),
    ).resolves.toBe(`${KNOWN_SECRET}\n`);
    expect(persistedBrowserState()).not.toContain(KNOWN_SECRET);

    getIdentityMock.mockReturnValue(null);
    encryptionState.value = {
      ...encryptionState.value,
      status: "locked",
      lockEpoch: 1,
    };
    rerender();
    await waitFor(() =>
      expect(result.current.encryptionState).toEqual({ status: "locked" }),
    );
    expect(result.current.bodyMarkdown).toBe("");
    expect(persistedBrowserState()).not.toContain(KNOWN_SECRET);
  });

  it("omits the body for a metadata-only protected save", async () => {
    encryptMarkdownMock.mockResolvedValue(ARMOR_B);
    const mutateAsync = vi.fn(
      async (_request: { body: Record<string, unknown> }) => ({
        ...makePage(),
        body: ARMOR_A,
        revision: "rev-b",
        meta: { ...makePage().meta, title: "Renamed" },
      }),
    );
    useUpdatePageMock.mockReturnValue({ mutateAsync });

    const { result } = renderHook(() => usePageEditor("notes/protected-a.md"));
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    act(() => result.current.setTitle("Renamed"));
    await act(async () => {
      await result.current.saveNow();
    });

    expect(mutateAsync.mock.calls[0]?.[0].body).not.toHaveProperty("body");
    expect(encryptMarkdownMock).not.toHaveBeenCalled();
  });

  it("keeps the successful plaintext as its baseline after a ciphertext response", async () => {
    encryptMarkdownMock.mockResolvedValue(ARMOR_B);
    const mutateAsync = vi.fn(async () => ({
      ...makePage(),
      body: ARMOR_B,
      revision: "rev-b",
    }));
    useUpdatePageMock.mockReturnValue({ mutateAsync });

    const { result } = renderHook(() => usePageEditor("notes/protected-a.md"));
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    act(() =>
      result.current.onSlateChange(
        paragraph("saved plaintext"),
        astChangeEditor(),
      ),
    );
    await act(async () => {
      await result.current.saveNow();
    });

    act(() =>
      result.current.onSlateChange(
        paragraph("saved plaintext"),
        astChangeEditor(),
      ),
    );
    await act(async () => {
      await result.current.saveNow();
    });

    expect(mutateAsync).toHaveBeenCalledOnce();
    expect(encryptMarkdownMock).toHaveBeenCalledOnce();
  });

  it("returns one awaitable flight that drains an edit queued during encryption", async () => {
    const firstEncryption = deferred<string>();
    const secondEncryption = deferred<string>();
    encryptMarkdownMock
      .mockReturnValueOnce(firstEncryption.promise)
      .mockReturnValueOnce(secondEncryption.promise);
    const mutateAsync = vi
      .fn()
      .mockImplementationOnce(async () => ({
        ...makePage(),
        body: ARMOR_A,
        revision: "rev-b",
      }))
      .mockImplementationOnce(async () => ({
        ...makePage(),
        body: ARMOR_B,
        revision: "rev-c",
      }));
    useUpdatePageMock.mockReturnValue({ mutateAsync });

    const { result } = renderHook(() => usePageEditor("notes/protected-a.md"));
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    act(() =>
      result.current.onSlateChange(paragraph("first edit"), astChangeEditor()),
    );
    let firstSave!: Promise<void>;
    act(() => {
      firstSave = result.current.saveNow();
    });
    await waitFor(() => expect(encryptMarkdownMock).toHaveBeenCalledOnce());

    act(() =>
      result.current.onSlateChange(paragraph("queued edit"), astChangeEditor()),
    );
    const queuedSave = result.current.saveNow();
    expect(queuedSave).toBe(firstSave);
    firstEncryption.resolve(ARMOR_A);
    await waitFor(() => expect(encryptMarkdownMock).toHaveBeenCalledTimes(2));
    expect(encryptMarkdownMock.mock.calls[1]?.[0]).toBe("queued edit\n");

    await act(async () => {
      secondEncryption.resolve(ARMOR_B);
      await queuedSave;
    });
    expect(mutateAsync).toHaveBeenCalledTimes(2);
    expect(result.current.saveStatus).toBe("saved");
  });

  it("registers an awaitable save flusher only for the encrypted mount", async () => {
    const unregister = vi.fn();
    registerFlusherMock.mockReturnValue(unregister);
    const encryption = deferred<string>();
    encryptMarkdownMock.mockReturnValue(encryption.promise);
    const mutateAsync = vi.fn(async () => ({
      ...makePage(),
      body: ARMOR_B,
      revision: "rev-b",
    }));
    useUpdatePageMock.mockReturnValue({ mutateAsync });

    const { result, unmount } = renderHook(() =>
      usePageEditor("notes/protected-a.md"),
    );
    await waitFor(() => expect(registerFlusherMock).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    act(() =>
      result.current.onSlateChange(paragraph("flush me"), astChangeEditor()),
    );

    const flusher = registerFlusherMock.mock.calls[0]?.[0];
    const flushing = flusher();
    let settled = false;
    void flushing.then(() => {
      settled = true;
    });
    await waitFor(() => expect(encryptMarkdownMock).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    await act(async () => {
      encryption.resolve(ARMOR_B);
      await flushing;
    });
    expect(settled).toBe(true);
    unmount();
    expect(unregister).toHaveBeenCalledOnce();
  });

  it("decrypts a ciphertext conflict reload and resets the plaintext baseline", async () => {
    let currentPage = makePage();
    const latest = makePage("notes/protected-a.md", ARMOR_B, "rev-b");
    const refetch = vi.fn(async () => {
      currentPage = latest;
      return { data: latest };
    });
    usePageMock.mockImplementation(() => ({
      data: currentPage,
      isLoading: false,
      error: null,
      refetch,
    }));
    decryptMarkdownMock.mockImplementation(async (armor: string) =>
      armor === ARMOR_B ? "reloaded plaintext\n" : "initial plaintext\n",
    );
    useUpdatePageMock.mockReturnValue({
      mutateAsync: vi.fn().mockRejectedValue(revisionConflict()),
    });

    const { result, rerender } = renderHook(() =>
      usePageEditor("notes/protected-a.md"),
    );
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    act(() =>
      result.current.onSlateChange(paragraph("local edit"), astChangeEditor()),
    );
    await act(async () => {
      await expect(result.current.saveNow()).rejects.toMatchObject({
        status: 409,
      });
    });

    await act(async () => {
      await result.current.reloadAfterConflict();
    });
    rerender();
    await waitFor(() =>
      expect(result.current.encryptionState).toEqual({
        status: "plain",
        body: "reloaded plaintext\n",
      }),
    );

    expect(markdownToSlateMock).not.toHaveBeenCalledWith(ARMOR_B);
    expect(markdownToSlateMock).toHaveBeenCalledWith("reloaded plaintext\n");
    expect(result.current.revisionConflict).toBeNull();
    expect(result.current.saveStatus).toBe("saved");
  });

  it("keeps a wrong-key conflict reload non-editable", async () => {
    let currentPage = makePage();
    const latest = makePage("notes/protected-a.md", ARMOR_B, "rev-b");
    const refetch = vi.fn(async () => {
      currentPage = latest;
      return { data: latest };
    });
    usePageMock.mockImplementation(() => ({
      data: currentPage,
      isLoading: false,
      error: null,
      refetch,
    }));
    decryptMarkdownMock.mockImplementation(async (armor: string) => {
      if (armor === ARMOR_B) throw new Error("SENSITIVE AUTH DETAIL");
      return "initial plaintext\n";
    });
    useUpdatePageMock.mockReturnValue({
      mutateAsync: vi.fn().mockRejectedValue(revisionConflict()),
    });

    const { result, rerender } = renderHook(() =>
      usePageEditor("notes/protected-a.md"),
    );
    await waitFor(() =>
      expect(result.current.encryptionState.status).toBe("plain"),
    );
    act(() =>
      result.current.onSlateChange(paragraph("local edit"), astChangeEditor()),
    );
    await act(async () => {
      await expect(result.current.saveNow()).rejects.toMatchObject({
        status: 409,
      });
    });
    await act(async () => {
      await result.current.reloadAfterConflict();
    });
    rerender();

    await waitFor(() =>
      expect(result.current.encryptionState).toEqual({
        status: "error",
        error: "Unable to authenticate encrypted note.",
      }),
    );
    expect(result.current.revisionConflict).toEqual({
      currentRevision: "rev-b",
    });
    expect(result.current.saveStatus).toBe("error");
    expect(markdownToSlateMock).not.toHaveBeenCalledWith(ARMOR_B);
    expect(JSON.stringify(result.current)).not.toContain(
      "SENSITIVE AUTH DETAIL",
    );
  });
});

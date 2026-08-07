import { QueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePageEditor } from "../usePageEditor";

const {
  decryptMarkdownMock,
  getIdentityMock,
  markdownToSlateMock,
  usePageMock,
  useUpdatePageMock,
  encryptionState,
} = vi.hoisted(() => ({
  decryptMarkdownMock: vi.fn(),
  getIdentityMock: vi.fn<() => string | null>(),
  markdownToSlateMock: vi.fn((body: string) => [
    { type: "paragraph", children: [{ text: body }] },
  ]),
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

vi.mock("#/crypto/EncryptionProvider", () => ({
  useOptionalEncryptionActions: () => ({
    getIdentity: getIdentityMock,
  }),
  useOptionalEncryptionStatus: () => encryptionState.value,
}));

vi.mock("#/crypto/age", () => ({
  decryptMarkdown: decryptMarkdownMock,
}));

vi.mock("../convert", () => ({
  markdownToSlate: markdownToSlateMock,
  slateToMarkdown: vi.fn(() => ""),
}));

const ARMOR_A = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRlZC1ib2R5LWE=
-----END AGE ENCRYPTED FILE-----`;
const ARMOR_B = `-----BEGIN AGE ENCRYPTED FILE-----
YWdlLWVuY3J5cHRlZC1ib2R5LWI=
-----END AGE ENCRYPTED FILE-----`;

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
    const page = makePage();
    usePageMock.mockImplementation((path: string) => ({
      data: path === page.path ? page : { ...page, path },
      isLoading: false,
      error: null,
      refetch: vi.fn(),
    }));
    useUpdatePageMock.mockReturnValue({ mutateAsync: vi.fn() });
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

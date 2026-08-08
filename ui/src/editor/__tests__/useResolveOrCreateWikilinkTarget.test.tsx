import type * as Intake from "#/lib/intake";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const {
  refetchAndLookupMock,
  searchGetMock,
  createMutateAsyncMock,
  generateShortIdMock,
} = vi.hoisted(() => ({
  refetchAndLookupMock: vi.fn(),
  searchGetMock: vi.fn(),
  createMutateAsyncMock: vi.fn(),
  generateShortIdMock: vi.fn(),
}));

vi.mock("#/editor/wikilinkResolution", () => ({
  useWikilinkResolution: () => ({
    refetchAndLookup: refetchAndLookupMock,
  }),
}));
vi.mock("#/api/client", () => ({
  fetchClient: { GET: searchGetMock },
}));
vi.mock("#/api/pages", () => ({
  useCreatePage: () => ({ mutateAsync: createMutateAsyncMock }),
}));
vi.mock("#/lib/intake", async (importOriginal) => {
  const actual = await importOriginal<typeof Intake>();
  return { ...actual, generateShortId: generateShortIdMock };
});

import { useResolveOrCreateWikilinkTarget } from "#/editor/useResolveOrCreateWikilinkTarget";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  refetchAndLookupMock.mockResolvedValue(null);
  searchGetMock.mockResolvedValue({ data: [] });
  createMutateAsyncMock.mockResolvedValue({});
});

it("returns a refreshed resolution without search or creation", async () => {
  refetchAndLookupMock.mockResolvedValue("notes/existing.md");
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  await expect(result.current.resolveOrCreate(" Existing ")).resolves.toEqual({
    path: "notes/existing.md",
    title: "Existing",
  });
  expect(searchGetMock).not.toHaveBeenCalled();
  expect(createMutateAsyncMock).not.toHaveBeenCalled();
});

it("reuses an NFC-normalized case-insensitive exact title", async () => {
  searchGetMock.mockResolvedValue({
    data: [
      { path: "notes/decoy.md", title: "Something Else" },
      { path: "notes/cafe.md", title: "Cafe\u{301} Notes" },
    ],
  });
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  await expect(
    result.current.resolveOrCreate("Caf\u{e9} Notes"),
  ).resolves.toEqual({
    path: "notes/cafe.md",
    title: "Caf\u{e9} Notes",
  });
  expect(createMutateAsyncMock).not.toHaveBeenCalled();
});

it("propagates search failure without creating a page", async () => {
  const searchError = { error: "search unavailable", status: 500 };
  searchGetMock.mockResolvedValue({ data: undefined, error: searchError });
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  await expect(result.current.resolveOrCreate("New Topic")).rejects.toBe(
    searchError,
  );
  expect(generateShortIdMock).not.toHaveBeenCalled();
  expect(createMutateAsyncMock).not.toHaveBeenCalled();
});

it("creates one blank canonical note when the target is unresolved", async () => {
  generateShortIdMock.mockReturnValue("a1B2c3D4");
  createMutateAsyncMock.mockResolvedValue({});
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  const target = await result.current.resolveOrCreate(" New Topic ");

  expect(target.title).toBe("New Topic");
  expect(target.path).toMatch(/^notes\/\d{8}\.new-topic\.a1B2c3D4\.md$/);
  expect(createMutateAsyncMock).toHaveBeenCalledWith({
    params: { path: { path: target.path } },
    body: { title: "New Topic" },
  });
});

it("rejects a blank target before I/O", async () => {
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());
  await expect(result.current.resolveOrCreate("   ")).rejects.toThrow(
    "Page title is required",
  );
  expect(refetchAndLookupMock).not.toHaveBeenCalled();
});

it("propagates creation failure", async () => {
  createMutateAsyncMock.mockRejectedValue(new Error("create failed"));
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());
  await expect(result.current.resolveOrCreate("New Topic")).rejects.toThrow(
    "create failed",
  );
});

it("coalesces simultaneous requests for the same normalized target", async () => {
  const pending = deferred<unknown>();
  createMutateAsyncMock.mockReturnValue(pending.promise);
  const { result } = renderHook(() => useResolveOrCreateWikilinkTarget());

  const first = result.current.resolveOrCreate("New Topic");
  const second = result.current.resolveOrCreate(" new topic ");
  await waitFor(() => expect(createMutateAsyncMock).toHaveBeenCalledTimes(1));

  pending.resolve({});
  await expect(Promise.all([first, second])).resolves.toHaveLength(2);
});

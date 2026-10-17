import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { BaseBulkResult } from "#/components/bases/base-table-model";
import { useBaseBulkActions } from "#/components/bases/useBaseBulkActions";

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  archive: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("#/api/bases", () => ({ usePropertyCommit: () => mocks.commit }));
vi.mock("#/api/pages", () => ({
  useArchivePage: () => ({ mutateAsync: mocks.archive }),
  useUpdatePage: () => ({ mutateAsync: mocks.update }),
}));
vi.mock("#/api/client", () => ({ fetchClient: { GET: mocks.get } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const rows = ["one", "two", "three"].map((id) => ({
  id,
  title: id,
  path: `${id}.md`,
  kind: "NOTE",
  columns: {},
}));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({
    data: { revision: "rev", encrypted: false, meta: { tags: ["old"] } },
  });
  mocks.refresh.mockResolvedValue(undefined);
});
it("keeps per-row conflict and protection failures while reporting successful writes", async () => {
  mocks.commit
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce({ status: 409, error: "Changed elsewhere" })
    .mockRejectedValueOnce({ status: 403, error: "Protected page" });
  const { result } = renderHook(() => useBaseBulkActions(mocks.refresh));
  let outcome: BaseBulkResult | undefined;
  await act(async () => {
    outcome = await result.current.run(rows, {
      kind: "set",
      key: "status",
      type: "select",
      value: "done",
    });
  });
  expect(outcome).toEqual({
    succeeded: ["one"],
    failures: [
      {
        id: "two",
        label: "two",
        message: expect.stringMatching(/409.*Changed elsewhere/),
      },
      {
        id: "three",
        label: "three",
        message: expect.stringMatching(/Protected page/),
      },
    ],
  });
  expect(mocks.commit).toHaveBeenCalledWith(
    rows[0],
    "status",
    "done",
    "select",
    "rev",
    { quiet: true },
  );
  expect(mocks.refresh).toHaveBeenCalledOnce();
});
it("adds tags using current editable tags and a guarded metadata update", async () => {
  const { result } = renderHook(() => useBaseBulkActions(mocks.refresh));
  await act(async () => {
    await result.current.run([rows[0]], { kind: "tag", tag: "new" });
  });
  expect(mocks.update).toHaveBeenCalledWith({
    params: { path: { path: "one.md" } },
    body: { expected_revision: "rev", tags: ["old", "new"] },
  });
});

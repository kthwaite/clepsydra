import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as BasesApi from "#/api/bases";
import type {
  BaseDetailResponse,
  BaseFilter,
  BaseViewEvaluateResponse,
  QueryOutput,
  SortKey,
} from "#/api/bases";
import { EMBED_DEFAULT_LIMIT } from "#/components/bases/embed-query";

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  createMember: vi.fn(),
  detailRefetch: vi.fn(),
  savedViewRefetch: vi.fn(),
  evaluationRefetch: vi.fn(),
  stableEvaluationRefetch: vi.fn(),
  useBase: vi.fn(),
  useBaseView: vi.fn(),
  useBaseViewEvaluation: vi.fn(),
  currentEvaluationConfig: undefined as unknown,
  evaluationState: {
    data: undefined as BaseViewEvaluateResponse | undefined,
    error: null as unknown,
    isLoading: false,
    isFetching: false,
  },
}));

const definition: BaseDetailResponse = {
  slug: "reading",
  revision: "detail-revision-must-not-own-embedded-creation",
  name: "Reading Log",
  properties: [
    {
      key: "status",
      definition: { type: "select", options: ["reading", "finished"] },
    },
  ],
  views: [
    { name: "Continues", layout: "table", columns: ["title", "status"] },
    { name: "Shelf", layout: "table", columns: ["title"] },
  ],
  diagnostics: [],
  member_creation: [
    { view: "Continues", enabled: false, fields: [], blockers: [] },
  ],
};

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...props }: { children: ReactNode }) => (
    <a {...props}>{children}</a>
  ),
}));

vi.mock("#/api/bases", async (importOriginal) => {
  const actual = await importOriginal<typeof BasesApi>();
  return {
    ...actual,
    useBase: (slug: string) => {
      mocks.useBase(slug);
      return {
        data: definition,
        error: null,
        isLoading: false,
        refetch: mocks.detailRefetch,
      };
    },
    useBaseView: (
      slug: string,
      view: string | undefined,
      overrides: BasesApi.ViewOverrides,
    ) => {
      mocks.useBaseView(slug, view, overrides);
      return {
        data: undefined,
        error: null,
        isLoading: false,
        isFetching: false,
        refetch: mocks.savedViewRefetch,
      };
    },
    useBaseViewEvaluation: (config: unknown) => {
      mocks.useBaseViewEvaluation(config);
      mocks.currentEvaluationConfig = config;
      return {
        ...mocks.evaluationState,
        refetch: mocks.stableEvaluationRefetch,
      };
    },
    useCreateBaseMember: () => ({
      mutateAsync: mocks.createMember,
      isPending: false,
    }),
    usePropertyCommit: () => mocks.commit,
  };
});

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));

import { BaseTableView } from "#/components/bases/BaseTableView";
import {
  type BaseTableControllerOptions,
  useBaseTableController,
} from "#/components/bases/useBaseTableController";

const readingFilter: BaseFilter = {
  field: "status",
  op: "eq",
  value: "reading",
};
const finishedFilter: BaseFilter = {
  field: "status",
  op: "eq",
  value: "finished",
};
const createdRow = {
  id: "created",
  path: "created.md",
  title: "Created",
  kind: "NOTE",
  columns: { status: "reading" },
};

function output(rows = [createdRow]): QueryOutput {
  return { shape: "flat", rows, total: rows.length };
}

function evaluation(
  overrides: Partial<BaseViewEvaluateResponse> = {},
): BaseViewEvaluateResponse {
  return {
    revision: "evaluation-rev-1",
    member_creation: {
      view: "Continues",
      enabled: true,
      fields: [],
      blockers: [],
    },
    output: output(),
    ...overrides,
  };
}

function options(
  overrides: Partial<BaseTableControllerOptions> = {},
): BaseTableControllerOptions {
  return {
    mode: "embedded",
    slug: "reading",
    activeView: "Continues",
    sort: undefined,
    filter: readingFilter,
    onViewChange: vi.fn(),
    onSortChange: vi.fn(),
    ...overrides,
  };
}

function ControllerTable({ value }: { value: BaseTableControllerOptions }) {
  const controller = useBaseTableController(value);
  const { detailLoading, detailMissing, definition, ...viewProps } = controller;
  if (detailLoading || detailMissing || !definition) return null;
  return <BaseTableView definition={definition} {...viewProps} />;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.commit.mockResolvedValue(undefined);
  mocks.evaluationState.data = evaluation();
  mocks.evaluationState.error = null;
  mocks.evaluationState.isLoading = false;
  mocks.evaluationState.isFetching = false;
  mocks.currentEvaluationConfig = undefined;
  mocks.stableEvaluationRefetch.mockImplementation(() =>
    mocks.evaluationRefetch(mocks.currentEvaluationConfig),
  );
  mocks.createMember.mockResolvedValue({
    id: "created",
    path: "created.md",
    title: "Created",
    revision: "page-rev-1",
  });
  mocks.evaluationRefetch.mockResolvedValue({
    data: mocks.evaluationState.data,
  });
});

describe("useBaseTableController embedded mode", () => {
  it("uses the normalized POST evaluator and response-owned capability/revision", async () => {
    const current = options();
    const { result } = renderHook(() => useBaseTableController(current));

    expect(mocks.useBaseViewEvaluation).toHaveBeenLastCalledWith({
      base: "reading",
      view: "Continues",
      filter: readingFilter,
      sort: undefined,
      limit: EMBED_DEFAULT_LIMIT,
    });
    expect(result.current.output).toEqual(output());
    expect(result.current.memberCapability).toEqual(
      mocks.evaluationState.data?.member_creation,
    );

    act(() => result.current.onAddMember());
    await act(async () => {
      result.current.onSaveMember?.({ title: " Created ", fields: {} });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.createMember).toHaveBeenCalledWith({
      params: { path: { slug: "reading" } },
      body: {
        base_revision: "evaluation-rev-1",
        embed_filter: readingFilter,
        view: "Continues",
        title: "Created",
        fields: {},
      },
    });
    await waitFor(() => expect(result.current.focusCreatedId).toBe("created"));
    expect(result.current.memberNotice).toBeUndefined();
  });

  it.each([
    {
      label: "focuses when only the current query includes the created row",
      oldOutput: output([]),
      currentOutput: output(),
      expectedFocus: "created",
      expectedNotice: undefined,
    },
    {
      label:
        "announces exclusion when only the old query includes the created row",
      oldOutput: output(),
      currentOutput: output([]),
      expectedFocus: undefined,
      expectedNotice:
        "The member was created, but it is not included in the current view.",
    },
  ])(
    "$label after sort changes while POST is pending",
    async ({ oldOutput, currentOutput, expectedFocus, expectedNotice }) => {
      const pending = deferred<{
        id: string;
        path: string;
        title: string;
        revision: string;
      }>();
      const newSort: SortKey[] = [{ field: "title", dir: "desc" }];
      const current = options();
      mocks.createMember.mockReturnValue(pending.promise);
      mocks.evaluationRefetch.mockImplementation(
        async (config: { sort?: SortKey[] }) => ({
          data: evaluation({
            output: config.sort === undefined ? oldOutput : currentOutput,
          }),
        }),
      );
      const { result, rerender } = renderHook(
        ({ value }) => useBaseTableController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.onAddMember());
      act(() => result.current.onSaveMember({ title: "Created", fields: {} }));
      mocks.evaluationState.data = evaluation({ output: currentOutput });
      rerender({ value: { ...current, sort: newSort } });
      pending.resolve({
        id: "created",
        path: "created.md",
        title: "Created",
        revision: "page-rev-1",
      });
      await act(async () => {
        await pending.promise;
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.memberNotice).toBe(expectedNotice),
      );
      expect(result.current.focusCreatedId).toBe(expectedFocus);
      expect(mocks.evaluationRefetch).toHaveBeenLastCalledWith({
        base: "reading",
        view: "Continues",
        filter: readingFilter,
        sort: newSort,
        limit: EMBED_DEFAULT_LIMIT,
      });
    },
  );

  it.each([
    {
      label: "discards focus-producing old-key rows",
      staleResult: { data: evaluation({ output: output() }) },
      currentOutput: output([]),
      expectedFocus: undefined,
      expectedNotice:
        "The member was created, but it is not included in the current view.",
    },
    {
      label: "discards an old-key refresh error",
      staleResult: { error: { error: "stale A refresh failed" } },
      currentOutput: output(),
      expectedFocus: "created",
      expectedNotice: undefined,
    },
  ])(
    "$label after the old refetch is already in flight",
    async ({ staleResult, currentOutput, expectedFocus, expectedNotice }) => {
      type RefreshResult = {
        data?: BaseViewEvaluateResponse;
        error?: { error: string };
      };
      const oldRefresh = deferred<RefreshResult>();
      const currentRefresh = deferred<RefreshResult>();
      const newSort: SortKey[] = [{ field: "title", dir: "desc" }];
      const current = options();
      mocks.evaluationRefetch.mockImplementation(
        (config: { sort?: SortKey[] }) =>
          config.sort === undefined
            ? oldRefresh.promise
            : currentRefresh.promise,
      );
      const { result, rerender } = renderHook(
        ({ value }) => useBaseTableController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.onAddMember());
      await act(async () => {
        result.current.onSaveMember({ title: "Created", fields: {} });
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(mocks.evaluationRefetch).toHaveBeenCalledTimes(1),
      );
      expect(mocks.evaluationRefetch).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: undefined }),
      );

      mocks.evaluationState.data = evaluation({ output: currentOutput });
      rerender({ value: { ...current, sort: newSort } });
      oldRefresh.resolve(staleResult);
      await act(async () => {
        await oldRefresh.promise;
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(mocks.evaluationRefetch).toHaveBeenCalledTimes(2),
      );
      expect(mocks.evaluationRefetch).toHaveBeenLastCalledWith({
        base: "reading",
        view: "Continues",
        filter: readingFilter,
        sort: newSort,
        limit: EMBED_DEFAULT_LIMIT,
      });
      expect(result.current.focusCreatedId).toBeUndefined();
      expect(result.current.memberNotice).toBeUndefined();
      expect(result.current.memberError).toBeUndefined();

      currentRefresh.resolve({
        data: evaluation({ output: currentOutput }),
      });
      await act(async () => {
        await currentRefresh.promise;
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(result.current.memberNotice).toBe(expectedNotice),
      );
      expect(result.current.focusCreatedId).toBe(expectedFocus);
      expect(mocks.evaluationRefetch).toHaveBeenCalledTimes(2);
      if (expectedFocus) {
        act(() => result.current.onCreatedRowFocused(expectedFocus));
      }
      expect(result.current.memberSaving).toBe(false);
    },
  );

  it("retains same-predicate draft state and capability while a new exact query is pending, but disables Save", async () => {
    const firstSort: SortKey[] = [{ field: "title", dir: "asc" }];
    const current = options();
    const { result, rerender } = renderHook(
      ({ value }) => useBaseTableController(value),
      { initialProps: { value: current } },
    );

    act(() => result.current.onAddMember());
    expect(result.current.memberDraftOpen).toBe(true);
    expect(result.current.memberSaving).toBe(false);

    mocks.evaluationState.data = undefined;
    mocks.evaluationState.isLoading = true;
    rerender({ value: { ...current, sort: firstSort } });

    expect(result.current.output).toBeUndefined();
    expect(result.current.memberDraftOpen).toBe(true);
    expect(result.current.memberCapability?.enabled).toBe(true);
    expect(result.current.memberSaving).toBe(true);

    mocks.evaluationState.data = evaluation({ revision: "evaluation-rev-2" });
    mocks.evaluationState.isLoading = false;
    rerender({ value: { ...current, sort: firstSort } });
    expect(result.current.memberDraftOpen).toBe(true);
    expect(result.current.memberSaving).toBe(false);
    await act(async () => {
      result.current.onSaveMember({ title: "Retained draft", fields: {} });
      await Promise.resolve();
    });
    expect(mocks.createMember).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({ base_revision: "evaluation-rev-2" }),
      }),
    );
  });

  it("keeps onSaveMember strictly stable across controller-local draft state", () => {
    const current = options();
    const { result } = renderHook(() => useBaseTableController(current));
    const onSaveMember = result.current.onSaveMember;

    act(() => result.current.onAddMember());

    expect(result.current.memberDraftOpen).toBe(true);
    expect(result.current.onSaveMember).toBe(onSaveMember);
  });

  it("keeps entered draft values mounted while a same-predicate revision refresh disables Save", async () => {
    const user = userEvent.setup();
    const current = options();
    const firstSort: SortKey[] = [{ field: "title", dir: "asc" }];
    const { rerender } = render(<ControllerTable value={current} />);

    await user.click(screen.getByRole("button", { name: "Add member" }));
    const title = screen.getByRole("textbox", { name: "New member — Title" });
    await user.type(title, "Retained draft");

    mocks.evaluationState.data = undefined;
    mocks.evaluationState.isLoading = true;
    rerender(<ControllerTable value={{ ...current, sort: firstSort }} />);
    expect(title).toHaveValue("Retained draft");
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).toBeDisabled();

    mocks.evaluationState.data = evaluation({ revision: "evaluation-rev-2" });
    mocks.evaluationState.isLoading = false;
    rerender(<ControllerTable value={{ ...current, sort: firstSort }} />);
    expect(title).toHaveValue("Retained draft");
    expect(
      screen.getByRole("button", { name: "Save new member" }),
    ).not.toBeDisabled();
  });

  it("obsoletes changed-predicate work across A to B to A and suppresses its refetch, focus, and notices", async () => {
    const pending = deferred<{
      id: string;
      path: string;
      title: string;
      revision: string;
    }>();
    mocks.createMember.mockReturnValue(pending.promise);
    const a = options();
    const { result, rerender } = renderHook(
      ({ value }) => useBaseTableController(value),
      { initialProps: { value: a } },
    );

    act(() => result.current.onAddMember());
    act(() => result.current.onSaveMember?.({ title: "Old A", fields: {} }));
    mocks.evaluationState.data = undefined;
    mocks.evaluationState.isLoading = true;
    rerender({ value: { ...a, filter: finishedFilter } });
    expect(result.current.memberDraftOpen).toBe(false);
    expect(result.current.output).toBeUndefined();

    rerender({ value: a });
    expect(result.current.output).toEqual(output());
    pending.resolve({
      id: "stale-a",
      path: "stale-a.md",
      title: "Old A",
      revision: "page-rev-old",
    });
    await act(async () => {
      await pending.promise;
      await Promise.resolve();
    });

    expect(mocks.evaluationRefetch).not.toHaveBeenCalled();
    expect(result.current.focusCreatedId).toBeUndefined();
    expect(result.current.memberNotice).toBeUndefined();
    expect(result.current.memberDraftOpen).toBe(false);
  });

  it("resets sort inheritance on view change and cancels an in-flight operation on unmount", async () => {
    const calls: string[] = [];
    const pending = deferred<{
      id: string;
      path: string;
      title: string;
      revision: string;
    }>();
    mocks.createMember.mockReturnValue(pending.promise);
    const onSortChange = vi.fn(() => calls.push("sort"));
    const onViewChange = vi.fn(() => calls.push("view"));
    const { result, unmount } = renderHook(() =>
      useBaseTableController(options({ onSortChange, onViewChange })),
    );

    act(() => result.current.onViewChange("Shelf"));
    expect(onSortChange).toHaveBeenCalledWith(undefined);
    expect(onViewChange).toHaveBeenCalledWith("Shelf");
    expect(calls).toEqual(["sort", "view"]);

    act(() => result.current.onAddMember());
    act(() => result.current.onSaveMember?.({ title: "Created", fields: {} }));
    unmount();
    pending.resolve({
      id: "created",
      path: "created.md",
      title: "Created",
      revision: "page-rev-1",
    });
    await pending.promise;
    await Promise.resolve();
    expect(mocks.evaluationRefetch).not.toHaveBeenCalled();
  });

  it("refreshes the embedded evaluation on revision conflict and preserves the draft", async () => {
    mocks.createMember.mockRejectedValue({
      status: 409,
      error: "revision conflict",
      detail: { code: "base_revision_conflict" },
    });
    const { result } = renderHook(() => useBaseTableController(options()));

    act(() => result.current.onAddMember());
    await act(async () => {
      result.current.onSaveMember({ title: "Still here", fields: {} });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.evaluationRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.detailRefetch).not.toHaveBeenCalled();
    expect(result.current.memberDraftOpen).toBe(true);
    expect(result.current.memberSaving).toBe(false);
    expect(result.current.memberError).toContain("revision conflict");
  });

  it.each([
    {
      label: "limit",
      changeQuery: (current: BaseTableControllerOptions) => ({
        ...current,
        limit: 2,
      }),
    },
    {
      label: "sort",
      changeQuery: (current: BaseTableControllerOptions) => ({
        ...current,
        sort: [{ field: "title", dir: "desc" }] satisfies SortKey[],
      }),
    },
  ])(
    "hides a completed capped-exclusion notice when the $label changes query identity",
    async ({ changeQuery }) => {
      mocks.evaluationState.data = evaluation({ output: output([]) });
      mocks.evaluationRefetch.mockResolvedValue({
        data: mocks.evaluationState.data,
      });
      const current = options({ limit: 1 });
      const { result, rerender } = renderHook(
        ({ value }) => useBaseTableController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.onAddMember());
      await act(async () => {
        result.current.onSaveMember({ title: "Created", fields: {} });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.memberNotice).toBe(
          "The member was created, but it is not included in the current view.",
        ),
      );
      expect(result.current.focusCreatedId).toBeUndefined();

      mocks.evaluationState.data = evaluation({ output: output() });
      rerender({ value: changeQuery(current) });

      expect(result.current.memberNotice).toBeUndefined();
      expect(result.current.focusCreatedId).toBeUndefined();
    },
  );

  it.each([
    {
      label: "limit",
      changeQuery: (current: BaseTableControllerOptions) => ({
        ...current,
        limit: 2,
      }),
    },
    {
      label: "sort",
      changeQuery: (current: BaseTableControllerOptions) => ({
        ...current,
        sort: [{ field: "title", dir: "desc" }] satisfies SortKey[],
      }),
    },
  ])(
    "hides completed placement focus when the $label changes query identity",
    async ({ changeQuery }) => {
      const current = options({ limit: 1 });
      const { result, rerender } = renderHook(
        ({ value }) => useBaseTableController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.onAddMember());
      await act(async () => {
        result.current.onSaveMember({ title: "Created", fields: {} });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.focusCreatedId).toBe("created"),
      );
      expect(result.current.memberNotice).toBeUndefined();

      mocks.evaluationState.data = evaluation({ output: output() });
      rerender({ value: changeQuery(current) });

      expect(result.current.focusCreatedId).toBeUndefined();
      expect(result.current.memberNotice).toBeUndefined();
    },
  );

  it.each([
    {
      label: "limit",
      changeQuery: (current: BaseTableControllerOptions) => ({
        ...current,
        limit: 2,
      }),
    },
    {
      label: "sort",
      changeQuery: (current: BaseTableControllerOptions) => ({
        ...current,
        sort: [{ field: "title", dir: "desc" }] satisfies SortKey[],
      }),
    },
  ])(
    "retains a generic post-creation refresh notice when the $label changes query identity",
    async ({ changeQuery }) => {
      mocks.evaluationRefetch.mockResolvedValue({
        error: { error: "refresh failed" },
      });
      const current = options({ limit: 1 });
      const { result, rerender } = renderHook(
        ({ value }) => useBaseTableController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.onAddMember());
      await act(async () => {
        result.current.onSaveMember({ title: "Created", fields: {} });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.memberNotice).toBe(
          "The member was created, but the current view could not be refreshed.",
        ),
      );

      mocks.evaluationState.data = evaluation({ output: output() });
      rerender({ value: changeQuery(current) });

      expect(result.current.memberNotice).toBe(
        "The member was created, but the current view could not be refreshed.",
      );
      expect(result.current.focusCreatedId).toBeUndefined();
    },
  );
});

describe("useBaseTableController standalone mode", () => {
  it("uses only the first sort key for the uncapped saved-view GET and detail capability", () => {
    const first: SortKey = { field: "title", dir: "desc" };
    const second: SortKey = { field: "status", dir: "asc" };
    const { result } = renderHook(() =>
      useBaseTableController({
        mode: "standalone",
        slug: "reading",
        activeView: "Continues",
        sort: [first, second],
        onViewChange: vi.fn(),
        onSortChange: vi.fn(),
      }),
    );

    expect(mocks.useBaseView).toHaveBeenLastCalledWith("reading", "Continues", {
      sort: "title",
      dir: "desc",
    });
    expect(mocks.useBaseViewEvaluation).toHaveBeenLastCalledWith({
      base: "",
      view: "",
      filter: undefined,
      sort: undefined,
      limit: EMBED_DEFAULT_LIMIT,
    });
    expect(result.current.memberCapability).toEqual(
      definition.member_creation?.[0],
    );
  });
});

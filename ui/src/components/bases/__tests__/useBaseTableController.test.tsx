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
import type { BaseMemberDraftValue } from "#/components/bases/member-draft";

const mocks = vi.hoisted(() => ({
  commit: vi.fn(),
  createMember: vi.fn(),
  updateBase: vi.fn(),
  detailRefetch: vi.fn(),
  savedViewRefetch: vi.fn(),
  evaluationRefetch: vi.fn(),
  stableEvaluationRefetch: vi.fn(),
  useBase: vi.fn(),
  useBaseView: vi.fn(),
  useBaseViewWindows: vi.fn(),
  get: vi.fn(),
  detailState: {
    data: undefined as BaseDetailResponse | undefined,
    error: null as unknown,
    isLoading: false,
  },
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
    { name: "Wide", layout: "table", columns: ["title", "status", "rating"] },
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
      return { ...mocks.detailState, refetch: mocks.detailRefetch };
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
    useBaseViewWindows: (config: unknown) => {
      mocks.useBaseViewWindows(config);
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
    useUpdateBase: () => ({
      mutateAsync: mocks.updateBase,
      isPending: false,
    }),
    usePropertyCommit: () => mocks.commit,
  };
});

vi.mock("#/hooks/useOpenTab", () => ({ useOpenTab: () => vi.fn() }));
vi.mock("#/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copied: false, copy: vi.fn() }),
}));
vi.mock("#/api/pages", () => ({
  useArchivePage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("#/api/client", () => ({ fetchClient: { GET: mocks.get } }));
vi.mock("#/lib/useProjects", () => ({ useProjects: () => [] }));

import { BaseTableView } from "#/components/bases/BaseTableView";
import type { BaseTableReadyModel } from "#/components/bases/base-table-model";
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
  return { shape: "flat", rows, total: rows.length, aggregates: [] };
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
  const model = useBaseTableController(value);
  if (model.status !== "ready") return null;
  return <BaseTableView model={model} />;
}

/** The controller's model, for tests whose definition is always ready. */
function useReadyController(
  value: BaseTableControllerOptions,
): BaseTableReadyModel {
  const model = useBaseTableController(value);
  if (model.status !== "ready") throw new Error(`model is ${model.status}`);
  return model;
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
  mocks.detailState.data = definition;
  mocks.detailState.error = null;
  mocks.detailState.isLoading = false;
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

describe("useBaseTableController status", () => {
  it.each(["standalone", "embedded"] as const)(
    "is loading while the %s definition loads",
    (mode) => {
      mocks.detailState.data = undefined;
      mocks.detailState.isLoading = true;
      const { result } = renderHook(() =>
        useBaseTableController(options({ mode })),
      );

      expect(result.current.status).toBe("loading");
    },
  );

  it.each([
    ["the definition request fails", { error: new Error("gone") }],
    ["there is no definition", { data: undefined }],
    [
      "the definition declares no views",
      { data: { ...definition, views: [] } },
    ],
  ])("is missing when %s", (_name, detail) => {
    Object.assign(mocks.detailState, detail);
    const { result } = renderHook(() =>
      useBaseTableController(options({ activeView: "" })),
    );

    expect(result.current).toEqual({ status: "missing", slug: "reading" });
  });

  it("is ready with the definition and the active view's query", () => {
    const { result } = renderHook(() => useBaseTableController(options()));
    const model = result.current;

    expect(model.status).toBe("ready");
    if (model.status !== "ready") return;
    expect(model.definition).toBe(definition);
    expect(model.query.activeView).toBe("Continues");
    expect(model.query.output).toEqual(output());
    expect(model.configureSlug).toBe("reading");
    expect(model.window).toBeDefined();
  });

  it("has no row window when standalone", () => {
    const { result } = renderHook(() =>
      useBaseTableController(options({ mode: "standalone" })),
    );
    const model = result.current;

    if (model.status !== "ready") throw new Error("expected ready");
    expect(model.configureSlug).toBe("reading");
    expect(model.window).toBeUndefined();
  });
});

describe("useBaseTableController embedded mode", () => {
  it("uses the normalized POST evaluator and response-owned capability/revision", async () => {
    const current = options();
    const { result } = renderHook(() => useReadyController(current));

    expect(mocks.useBaseViewWindows).toHaveBeenLastCalledWith({
      base: "reading",
      view: "Continues",
      filter: readingFilter,
      sort: undefined,
      limit: undefined,
    });
    expect(result.current.query.output).toEqual(output());
    expect(result.current.members.capability).toEqual(
      mocks.evaluationState.data?.member_creation,
    );

    act(() => result.current.members.onAdd());
    await act(async () => {
      result.current.members.onSave?.({ title: " Created ", fields: {} });
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
    await waitFor(() =>
      expect(result.current.members.focusCreatedId).toBe("created"),
    );
    expect(result.current.members.notice).toBeUndefined();
  });

  it("omits nullish fields and preserves other falsey fields at the create adapter boundary", async () => {
    const { result } = renderHook(() => useReadyController(options()));
    const fields = {
      absentNull: null,
      absentUndefined: undefined,
      zero: 0,
      disabled: false,
      empty: "",
      list: [],
    } as unknown as BaseMemberDraftValue["fields"];

    act(() => result.current.members.onAdd());
    await act(async () => {
      result.current.members.onSave({ title: " Falsey values ", fields });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.createMember).toHaveBeenCalledWith({
      params: { path: { slug: "reading" } },
      body: {
        base_revision: "evaluation-rev-1",
        embed_filter: readingFilter,
        view: "Continues",
        title: "Falsey values",
        fields: {
          zero: 0,
          disabled: false,
          empty: "",
          list: [],
        },
      },
    });
    expect(mocks.createMember.mock.calls[0][0].body.fields).not.toHaveProperty(
      "absentUndefined",
    );
  });

  it.each([
    {
      label: "loading",
      state: { isLoading: true, isFetching: false, error: null },
    },
    {
      label: "fetching",
      state: { isLoading: false, isFetching: true, error: null },
    },
    {
      label: "failed",
      state: {
        isLoading: false,
        isFetching: false,
        error: { error: "evaluation failed" },
      },
    },
  ])(
    "does not expose or submit member creation while the evaluation is $label",
    async ({ state }) => {
      Object.assign(mocks.evaluationState, state);
      const { result } = renderHook(() => useReadyController(options()));

      expect(result.current.members.capability).toBeUndefined();
      act(() => result.current.members.onAdd());
      expect(result.current.members.draftOpen).toBe(false);

      await act(async () => {
        result.current.members.onSave({
          title: "Not authoritative",
          fields: {},
        });
        await Promise.resolve();
      });

      expect(mocks.createMember).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      label: "loading",
      state: { isLoading: true, isFetching: false, error: null },
    },
    {
      label: "fetching",
      state: { isLoading: false, isFetching: true, error: null },
    },
    {
      label: "failed",
      state: {
        isLoading: false,
        isFetching: false,
        error: { error: "evaluation failed" },
      },
    },
  ])(
    "renders unavailable Add actions while the evaluation is $label",
    ({ state }) => {
      Object.assign(mocks.evaluationState, state);

      render(<ControllerTable value={options()} />);

      const addActions = screen.getAllByRole("button", { name: /Add member/ });
      expect(addActions.length).toBeGreaterThan(0);
      for (const add of addActions) {
        expect(add).toBeDisabled();
        expect(add).toHaveAccessibleDescription(
          "Member creation is unavailable for this view.",
        );
      }
    },
  );

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
        ({ value }) => useReadyController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.members.onAdd());
      act(() =>
        result.current.members.onSave({ title: "Created", fields: {} }),
      );
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
        expect(result.current.members.notice).toBe(expectedNotice),
      );
      expect(result.current.members.focusCreatedId).toBe(expectedFocus);
      expect(mocks.evaluationRefetch).toHaveBeenLastCalledWith({
        base: "reading",
        view: "Continues",
        filter: readingFilter,
        sort: newSort,
        limit: undefined,
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
        ({ value }) => useReadyController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.members.onAdd());
      await act(async () => {
        result.current.members.onSave({ title: "Created", fields: {} });
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
        limit: undefined,
      });
      expect(result.current.members.focusCreatedId).toBeUndefined();
      expect(result.current.members.notice).toBeUndefined();
      expect(result.current.members.error).toBeUndefined();

      currentRefresh.resolve({
        data: evaluation({ output: currentOutput }),
      });
      await act(async () => {
        await currentRefresh.promise;
        await Promise.resolve();
      });
      await waitFor(() =>
        expect(result.current.members.notice).toBe(expectedNotice),
      );
      expect(result.current.members.focusCreatedId).toBe(expectedFocus);
      expect(mocks.evaluationRefetch).toHaveBeenCalledTimes(2);
      if (expectedFocus) {
        act(() => result.current.members.onCreatedRowFocused(expectedFocus));
      }
      expect(result.current.members.saving).toBe(false);
    },
  );

  it("retains same-predicate open-draft fields while a new exact query is pending, but hides current capability and disables Save", async () => {
    const firstSort: SortKey[] = [{ field: "title", dir: "asc" }];
    const current = options();
    const { result, rerender } = renderHook(
      ({ value }) => useReadyController(value),
      { initialProps: { value: current } },
    );

    act(() => result.current.members.onAdd());
    const retainedDraftFields = result.current.members.draftFields;
    expect(result.current.members.draftOpen).toBe(true);
    expect(result.current.members.saving).toBe(false);

    mocks.evaluationState.data = undefined;
    mocks.evaluationState.isLoading = true;
    rerender({ value: { ...current, sort: firstSort } });

    expect(result.current.query.output).toBeUndefined();
    expect(result.current.members.draftOpen).toBe(true);
    expect(result.current.members.capability).toBeUndefined();
    expect(result.current.members.draftFields).toBe(retainedDraftFields);
    expect(result.current.members.saving).toBe(true);

    mocks.evaluationState.data = evaluation({ revision: "evaluation-rev-2" });
    mocks.evaluationState.isLoading = false;
    rerender({ value: { ...current, sort: firstSort } });
    expect(result.current.members.draftOpen).toBe(true);
    expect(result.current.members.saving).toBe(false);
    await act(async () => {
      result.current.members.onSave({ title: "Retained draft", fields: {} });
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
    const { result } = renderHook(() => useReadyController(current));
    const onSaveMember = result.current.members.onSave;

    act(() => result.current.members.onAdd());

    expect(result.current.members.draftOpen).toBe(true);
    expect(result.current.members.onSave).toBe(onSaveMember);
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
      ({ value }) => useReadyController(value),
      { initialProps: { value: a } },
    );

    act(() => result.current.members.onAdd());
    act(() => result.current.members.onSave?.({ title: "Old A", fields: {} }));
    mocks.evaluationState.data = undefined;
    mocks.evaluationState.isLoading = true;
    rerender({ value: { ...a, filter: finishedFilter } });
    expect(result.current.members.draftOpen).toBe(false);
    expect(result.current.query.output).toBeUndefined();

    rerender({ value: a });
    expect(result.current.query.output).toEqual(output());
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
    expect(result.current.members.focusCreatedId).toBeUndefined();
    expect(result.current.members.notice).toBeUndefined();
    expect(result.current.members.draftOpen).toBe(false);
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
      useReadyController(options({ onSortChange, onViewChange })),
    );

    act(() => result.current.query.onViewChange("Shelf"));
    expect(onSortChange).toHaveBeenCalledWith(undefined);
    expect(onViewChange).toHaveBeenCalledWith("Shelf");
    expect(calls).toEqual(["sort", "view"]);

    act(() => result.current.members.onAdd());
    act(() =>
      result.current.members.onSave?.({ title: "Created", fields: {} }),
    );
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
    const { result } = renderHook(() => useReadyController(options()));

    act(() => result.current.members.onAdd());
    await act(async () => {
      result.current.members.onSave({ title: "Still here", fields: {} });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.evaluationRefetch).toHaveBeenCalledTimes(1);
    expect(mocks.detailRefetch).not.toHaveBeenCalled();
    expect(result.current.members.draftOpen).toBe(true);
    expect(result.current.members.saving).toBe(false);
    expect(result.current.members.error).toContain("revision conflict");
  });

  it("reports conflict refresh failure and preserves the embedded draft", async () => {
    mocks.createMember.mockRejectedValue({
      status: 409,
      error: "revision conflict",
      detail: { code: "base_revision_conflict" },
    });
    mocks.evaluationRefetch.mockResolvedValue({
      data: undefined,
      error: new Error("evaluation refresh failed"),
    });
    const { result } = renderHook(() => useReadyController(options()));

    act(() => result.current.members.onAdd());
    await act(async () => {
      result.current.members.onSave({ title: "Still here", fields: {} });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.evaluationRefetch).toHaveBeenCalledTimes(1);
    expect(result.current.members.draftOpen).toBe(true);
    expect(result.current.members.saving).toBe(false);
    expect(result.current.members.error).toBe("evaluation refresh failed");
  });

  it("redirects an old embedded query conflict refresh to the current query", async () => {
    type RefreshResult = {
      data?: BaseViewEvaluateResponse;
      error?: { error: string };
    };
    const oldRefresh = deferred<RefreshResult>();
    const currentRefresh = deferred<RefreshResult>();
    const newSort: SortKey[] = [{ field: "title", dir: "desc" }];
    const current = options();
    mocks.createMember.mockRejectedValue({
      status: 409,
      error: "revision conflict",
      detail: { code: "base_revision_conflict" },
    });
    mocks.evaluationRefetch.mockImplementation(
      (config: { sort?: SortKey[] }) =>
        config.sort === undefined ? oldRefresh.promise : currentRefresh.promise,
    );
    const { result, rerender } = renderHook(
      ({ value }) => useReadyController(value),
      { initialProps: { value: current } },
    );

    act(() => result.current.members.onAdd());
    await act(async () => {
      result.current.members.onSave({ title: "Still here", fields: {} });
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(mocks.evaluationRefetch).toHaveBeenCalledTimes(1),
    );

    rerender({ value: { ...current, sort: newSort } });
    oldRefresh.resolve({ data: evaluation() });
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
      limit: undefined,
    });
    expect(result.current.members.saving).toBe(true);

    currentRefresh.resolve({ data: evaluation() });
    await act(async () => {
      await currentRefresh.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.members.saving).toBe(false));
    expect(result.current.members.draftOpen).toBe(true);
    expect(result.current.members.error).toBe("revision conflict");
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
        ({ value }) => useReadyController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.members.onAdd());
      await act(async () => {
        result.current.members.onSave({ title: "Created", fields: {} });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.members.notice).toBe(
          "The member was created, but it is not included in the current view.",
        ),
      );
      expect(result.current.members.focusCreatedId).toBeUndefined();

      mocks.evaluationState.data = evaluation({ output: output() });
      rerender({ value: changeQuery(current) });

      expect(result.current.members.notice).toBeUndefined();
      expect(result.current.members.focusCreatedId).toBeUndefined();
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
        ({ value }) => useReadyController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.members.onAdd());
      await act(async () => {
        result.current.members.onSave({ title: "Created", fields: {} });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.members.focusCreatedId).toBe("created"),
      );
      expect(result.current.members.notice).toBeUndefined();

      mocks.evaluationState.data = evaluation({ output: output() });
      rerender({ value: changeQuery(current) });

      expect(result.current.members.focusCreatedId).toBeUndefined();
      expect(result.current.members.notice).toBeUndefined();
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
        ({ value }) => useReadyController(value),
        { initialProps: { value: current } },
      );

      act(() => result.current.members.onAdd());
      await act(async () => {
        result.current.members.onSave({ title: "Created", fields: {} });
        await Promise.resolve();
        await Promise.resolve();
      });

      await waitFor(() =>
        expect(result.current.members.notice).toBe(
          "The member was created, but the current view could not be refreshed.",
        ),
      );

      mocks.evaluationState.data = evaluation({ output: output() });
      rerender({ value: changeQuery(current) });

      expect(result.current.members.notice).toBe(
        "The member was created, but the current view could not be refreshed.",
      );
      expect(result.current.members.focusCreatedId).toBeUndefined();
    },
  );
});

describe("useBaseTableController standalone mode", () => {
  it("uses only the first sort key for the uncapped saved-view GET and detail capability", () => {
    const first: SortKey = { field: "title", dir: "desc" };
    const second: SortKey = { field: "status", dir: "asc" };
    const { result } = renderHook(() =>
      useReadyController({
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
    expect(mocks.useBaseViewWindows).toHaveBeenLastCalledWith({
      base: "",
      view: "",
      filter: undefined,
      sort: undefined,
      limit: undefined,
    });
    expect(result.current.members.capability).toEqual(
      definition.member_creation?.[0],
    );
  });

  it("uses the case-folded definition capability and detail revision", async () => {
    const { result } = renderHook(() =>
      useReadyController({
        mode: "standalone",
        slug: "reading",
        activeView: "CONTINUES",
        sort: undefined,
        onViewChange: vi.fn(),
        onSortChange: vi.fn(),
      }),
    );

    expect(result.current.members.capability).toEqual(
      definition.member_creation?.[0],
    );
    act(() => result.current.members.onAdd());
    await act(async () => {
      result.current.members.onSave({ title: " Definition ", fields: {} });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.createMember).toHaveBeenCalledWith({
      params: { path: { slug: "reading" } },
      body: {
        base_revision: "detail-revision-must-not-own-embedded-creation",
        view: "CONTINUES",
        title: "Definition",
        fields: {},
      },
    });
  });
});

describe("view overrides", () => {
  it("sends quick filters and the group override with the standalone view request", async () => {
    const user = userEvent.setup();
    let model!: BaseTableReadyModel;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useReadyController(value);
      return null;
    }
    render(
      <Probe value={options({ mode: "standalone", filter: undefined })} />,
    );
    act(() => {
      model.overrides.onAddQuickFilter({
        field: "status",
        op: "eq",
        value: "reading",
        label: "status is reading",
      });
      model.overrides.onSetGroup({ kind: "flat" });
    });
    await waitFor(() =>
      expect(mocks.useBaseView).toHaveBeenLastCalledWith(
        "reading",
        "Continues",
        {
          filter: { field: "status", op: "eq", value: "reading" },
          groupBy: { kind: "flat" },
        },
      ),
    );
    expect(model.overrides.state.quickFilters).toHaveLength(1);
    void user;
  });

  it("composes the fence filter with quick filters for an embedded view", async () => {
    let model!: BaseTableReadyModel;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useReadyController(value);
      return null;
    }
    render(<Probe value={options()} />); // embedded, fence filter = readingFilter
    act(() => {
      model.overrides.onAddQuickFilter({
        field: "status",
        op: "ne",
        value: "finished",
        label: "status is not finished",
      });
      model.overrides.onSetGroup({ kind: "by", field: "status" });
    });
    await waitFor(() =>
      expect(mocks.currentEvaluationConfig).toMatchObject({
        filter: {
          all: [
            readingFilter,
            { field: "status", op: "ne", value: "finished" },
          ],
        },
        groupBy: { kind: "by", field: "status" },
      }),
    );
  });

  it("posts the effective embed filter when duplicating a row", async () => {
    mocks.get.mockImplementation(async (path: string) =>
      path.includes("/properties")
        ? { data: { properties: [] } }
        : { data: { meta: { tags: [] } } },
    );
    let model!: BaseTableReadyModel;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useReadyController(value);
      return null;
    }
    render(<Probe value={options()} />); // embedded, fence filter = readingFilter
    act(() => {
      model.overrides.onAddQuickFilter({
        field: "status",
        op: "ne",
        value: "finished",
        label: "status is not finished",
      });
    });
    const effectiveFilter = {
      all: [readingFilter, { field: "status", op: "ne", value: "finished" }],
    };
    await waitFor(() =>
      expect(mocks.currentEvaluationConfig).toMatchObject({
        filter: effectiveFilter,
      }),
    );

    act(() => model.rowActions.onDuplicateRow(createdRow));

    await waitFor(() =>
      expect(mocks.createMember).toHaveBeenCalledWith(
        expect.objectContaining({
          body: expect.objectContaining({ embed_filter: effectiveFilter }),
        }),
      ),
    );
  });

  it("resets overrides when the view changes", () => {
    let model!: BaseTableReadyModel;
    const onViewChange = vi.fn();
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useReadyController(value);
      return null;
    }
    const { rerender } = render(
      <Probe value={options({ mode: "standalone", onViewChange })} />,
    );
    act(() => model.overrides.onHideColumn("status"));
    expect(model.overrides.state.hiddenColumns).toEqual(["status"]);
    act(() => model.query.onViewChange("Shelf"));
    rerender(
      <Probe
        value={options({
          mode: "standalone",
          onViewChange,
          activeView: "Shelf",
        })}
      />,
    );
    expect(model.overrides.state.hiddenColumns).toEqual([]);
  });

  it("saves overrides into the view through the revision-guarded PUT and clears them", async () => {
    mocks.updateBase.mockResolvedValue({ revision: "r2", diagnostics: [] });
    let model!: BaseTableReadyModel;
    const onSortChange = vi.fn();
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useReadyController(value);
      return null;
    }
    render(
      <Probe
        value={options({
          mode: "standalone",
          filter: undefined,
          sort: [{ field: "status", dir: "desc" }],
          onSortChange,
        })}
      />,
    );
    act(() => {
      model.overrides.onAddQuickFilter({
        field: "status",
        op: "eq",
        value: "reading",
        label: "status is reading",
      });
      model.overrides.onHideColumn("status");
    });
    await act(async () => model.overrides.onSave());
    expect(mocks.updateBase).toHaveBeenCalledWith({
      params: { path: { slug: "reading" } },
      body: {
        expected_revision: definition.revision,
        definition: {
          name: "Reading Log",
          properties: definition.properties,
          views: [
            {
              name: "Continues",
              layout: "table",
              columns: ["title"],
              filter: { field: "status", op: "eq", value: "reading" },
              sort: [{ field: "status", dir: "desc" }],
            },
            { name: "Shelf", layout: "table", columns: ["title"] },
            {
              name: "Wide",
              layout: "table",
              columns: ["title", "status", "rating"],
            },
          ],
        },
        view_origins: [
          { kind: "existing", name: "Continues" },
          { kind: "existing", name: "Shelf" },
          { kind: "existing", name: "Wide" },
        ],
      },
    });
    expect(model.overrides.state.quickFilters).toEqual([]);
    expect(onSortChange).toHaveBeenCalledWith(undefined);
    expect(model.overrides.save).toEqual({ phase: "idle" });
  });

  it("treats a reorder back to the saved order as no override", () => {
    let model!: BaseTableReadyModel;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useReadyController(value);
      return null;
    }
    render(
      <Probe value={options({ mode: "standalone", filter: undefined })} />,
    );
    act(() => model.overrides.onReorderColumns(["status", "title"]));
    // Title stays first, so this order is the saved one: no override.
    expect(model.overrides.state.columnOrder).toBeUndefined();
    act(() => model.overrides.onReorderColumns(["title", "ghost", "status"]));
    expect(model.overrides.state.columnOrder).toBeUndefined();
  });

  it("writes a reordered view through the revision-guarded PUT", async () => {
    mocks.updateBase.mockResolvedValue({ revision: "r2", diagnostics: [] });
    let model!: BaseTableReadyModel;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useReadyController(value);
      return null;
    }
    render(
      <Probe
        value={options({
          mode: "standalone",
          filter: undefined,
          activeView: "Wide",
        })}
      />,
    );
    act(() => model.overrides.onReorderColumns(["title", "rating", "status"]));
    expect(model.overrides.state.columnOrder).toEqual([
      "title",
      "rating",
      "status",
    ]);
    act(() => model.overrides.onResetColumnOrder());
    expect(model.overrides.state.columnOrder).toBeUndefined();
    act(() => model.overrides.onReorderColumns(["title", "rating", "status"]));
    await act(async () => model.overrides.onSave());
    expect(mocks.updateBase).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.objectContaining({
          expected_revision: definition.revision,
          definition: expect.objectContaining({
            views: expect.arrayContaining([
              {
                name: "Wide",
                layout: "table",
                columns: ["title", "rating", "status"],
              },
            ]),
          }),
        }),
      }),
    );
    expect(model.overrides.state.columnOrder).toBeUndefined();
  });

  it("reports a conflict and keeps the overrides", async () => {
    mocks.updateBase.mockRejectedValue({
      status: 409,
      error: "conflict",
      detail: {},
    });
    let model!: BaseTableReadyModel;
    function Probe({ value }: { value: BaseTableControllerOptions }) {
      model = useReadyController(value);
      return null;
    }
    render(
      <Probe value={options({ mode: "standalone", filter: undefined })} />,
    );
    act(() => model.overrides.onSetGroup({ kind: "by", field: "status" }));
    await act(async () => model.overrides.onSave());
    expect(model.overrides.save).toEqual({
      phase: "conflict",
      message: "This base changed elsewhere. Reload, then save again.",
    });
    expect(model.overrides.state.group).toEqual({
      kind: "by",
      field: "status",
    });
    await act(async () => model.overrides.onReloadDefinition());
    expect(mocks.detailRefetch).toHaveBeenCalled();
    expect(model.overrides.save).toEqual({ phase: "idle" });
  });

  it("exposes onShowColumn, which undoes one onHideColumn", () => {
    const { result } = renderHook(() =>
      useReadyController({
        mode: "standalone",
        slug: "reading",
        activeView: "Continues",
        sort: undefined,
        onViewChange: vi.fn(),
        onSortChange: vi.fn(),
      }),
    );
    act(() => {
      result.current.overrides.onHideColumn("status");
      result.current.overrides.onHideColumn("rating");
    });
    expect(result.current.overrides.state.hiddenColumns).toEqual([
      "status",
      "rating",
    ]);
    act(() => result.current.overrides.onShowColumn("status"));
    expect(result.current.overrides.state.hiddenColumns).toEqual(["rating"]);
  });
});

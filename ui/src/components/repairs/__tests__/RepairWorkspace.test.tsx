import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceRepairApiError, type ReferenceIssue } from "#/api/index";
import { RepairWorkspace } from "../RepairWorkspace";
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>["resolve"];
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  issues: [] as ReferenceIssue[],
  queryFilters: null as Record<string, unknown> | null,
  total: 1,
  isPending: false,
  hasData: true,
  queryError: null as Error | null,
  preview: vi.fn(),
  apply: vi.fn(),
  refetch: vi.fn(),
  refetchGate: null as Deferred<unknown> | null,
  openTab: vi.fn(),
  mobile: false,
}));

vi.mock("#/api/index", () => {
  class ReferenceRepairApiError extends Error {
    status: number;
    payload: { error: string };
    cause: { error: string };
    constructor(payload: { error: string }, status: number) {
      super(payload.error);
      this.status = status;
      this.payload = payload;
      this.cause = payload;
    }
  }
  return {
    ReferenceRepairApiError,
    useReferenceIssues: (filters: Record<string, unknown>) => {
      mocks.queryFilters = filters;
      return {
        data:
          mocks.queryError || !mocks.hasData
            ? undefined
            : {
                items: mocks.issues,
                limit: Number(filters.limit ?? 100),
                offset: Number(filters.offset ?? 0),
                total: mocks.total,
              },
        isPending: mocks.isPending,
        isError: Boolean(mocks.queryError),
        error: mocks.queryError,
        refetch: () =>
          mocks.refetchGate ? mocks.refetchGate.promise : mocks.refetch(),
      };
    },
    usePreviewReferenceRepair: () => ({
      mutateAsync: mocks.preview,
      isPending: false,
      reset: vi.fn(),
    }),
    useApplyReferenceRepair: () => ({
      mutateAsync: mocks.apply,
      isPending: false,
      reset: vi.fn(),
    }),
  };
});

vi.mock("#/hooks/useMobileLayout", () => ({
  useMobileLayout: () => mocks.mobile,
}));

vi.mock("#/hooks/useOpenTab", () => ({
  useOpenTab: () => mocks.openTab,
}));

const unresolvedIssue: ReferenceIssue = {
  fingerprint: "unresolved-1",
  kind: "unresolved_page_link",
  source_id: "source-1",
  source_path: "notes/source.md",
  source_revision: "rev-1",
  source_title: "Source Note",
  target_raw: "Unresolved Target",
  snippet: "See [[Unresolved Target]] for context.",
  span_start: 4,
  span_end: 25,
  source_field: null,
  actions: ["replace", "open_source"],
  candidates: [
    {
      page_id: "candidate-1",
      path: "notes/target.md",
      title: "Target Note",
      rationale: "Exact normalized title",
    },
  ],
};

const ambiguousIssue: ReferenceIssue = {
  ...unresolvedIssue,
  fingerprint: "ambiguous-1",
  kind: "ambiguous_page_link",
  source_id: "source-2",
  source_path: "notes/second.md",
  source_revision: "rev-2",
  target_raw: "Second Target",
};

const navigationOnlyIssue: ReferenceIssue = {
  ...unresolvedIssue,
  fingerprint: "encrypted-1",
  source_id: "source-3",
  source_path: "private/encrypted.md",
  source_revision: "rev-3",
  source_title: "Encrypted Note",
  target_raw: "Protected Target",
  snippet: null,
  actions: ["open_source"],
  candidates: [],
};

const createIssue: ReferenceIssue = {
  ...unresolvedIssue,
  fingerprint: "create-1",
  source_revision: "rev-create",
  target_raw: "Missing Page",
  actions: ["create", "open_source"],
  candidates: [],
};

const orphanIssue: ReferenceIssue = {
  ...unresolvedIssue,
  fingerprint: "orphan-1",
  kind: "orphan_page",
  target_raw: null,
  snippet: null,
  actions: ["open_source"],
  candidates: [],
};

function renderWorkspace(
  props: Partial<ComponentProps<typeof RepairWorkspace>> = {},
) {
  return render(<RepairWorkspace {...props} />);
}

beforeEach(() => {
  mocks.issues = [unresolvedIssue];
  mocks.isPending = false;
  mocks.queryError = null;
  mocks.mobile = false;
  mocks.hasData = true;
  mocks.total = mocks.issues.length;
  mocks.queryFilters = null;
  mocks.refetchGate = null;
  mocks.preview.mockReset().mockResolvedValue({
    fingerprint: unresolvedIssue.fingerprint,
    before: "[[Unresolved Target]]",
    after: "[[notes/target.md]]",
    plan: {
      file_ops: [
        {
          kind: "create_file",
          path: "notes/source.md",
          destination: "notes/target.md",
        },
      ],
      text_edits: [
        {
          path: "notes/source.md",
          old_text: "[[Unresolved Target]]",
          new_text: "[[notes/target.md]]",
        },
      ],
    },
  });
  mocks.apply.mockReset().mockResolvedValue({
    fingerprint: unresolvedIssue.fingerprint,
    notification: { message: "Repair applied" },
  });
  mocks.refetch.mockReset().mockResolvedValue(undefined);
  mocks.openTab.mockReset();
});

describe("RepairWorkspace", () => {
  it("previews before applying and retains the row until invalidation", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );

    expect(mocks.preview).toHaveBeenCalledWith({
      fingerprint: "unresolved-1",
      source_revision: "rev-1",
      action: { type: "replace", candidate_page_id: "candidate-1" },
    });
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(screen.getAllByText("[[notes/target.md]]")[0]).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Apply previewed repair" }),
    );

    expect(mocks.apply).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: /Unresolved Target/ }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Repair applied");
  });

  it("reports filter changes for route URL state", async () => {
    const user = userEvent.setup();
    const onFiltersChange = vi.fn();
    renderWorkspace({ onFiltersChange });

    await user.type(screen.getByRole("textbox", { name: "Project" }), "Atlas");
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ project: "Atlas" }),
    );

    await user.click(
      screen.getByRole("checkbox", { name: "Unresolved links" }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Orphans" }));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: ["unresolved_page_link", "orphan_page"],
        offset: 0,
      }),
    );

    await user.click(screen.getByRole("button", { name: /Repairability/ }));
    await user.click(screen.getByRole("option", { name: "Actionable only" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionable: true }),
    );
  });

  it("makes navigation-only protected issues explicit and opens their source", async () => {
    const user = userEvent.setup();
    mocks.issues = [navigationOnlyIssue];
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: /Protected Target/ }));
    expect(
      screen.getByText(/source text is unavailable or redacted/i),
    ).toBeVisible();
    expect(screen.getByText(/no in-place action is offered/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open source" }));
    expect(mocks.openTab).toHaveBeenCalledWith(
      "page",
      "private/encrypted.md",
      "Encrypted Note",
    );
  });

  it("refreshes and announces a stale 409 preview", async () => {
    mocks.preview.mockRejectedValueOnce(
      new ReferenceRepairApiError(
        { error: "stale reference" } as never,
        409,
        "",
      ),
    );
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /issue changed.*refreshed/i,
    );
    expect(mocks.refetch).toHaveBeenCalledTimes(1);
  });

  it("moves through the issue ledger and into detail with the keyboard", async () => {
    mocks.issues = [unresolvedIssue, ambiguousIssue];
    const user = userEvent.setup();
    renderWorkspace();

    const first = screen.getByRole("button", { name: /Unresolved Target/ });
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("button", { name: /Second Target/ })).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("region", { name: "Repair detail" })).toHaveFocus();
  });

  it("selects the focused row before ArrowRight enters detail", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const row = screen.getByRole("button", { name: /Unresolved Target/ });
    row.focus();

    await user.keyboard("{ArrowRight}");

    expect(screen.getByRole("region", { name: "Repair detail" })).toHaveFocus();
    expect(
      screen.getByRole("heading", { name: "Unresolved Target" }),
    ).toBeVisible();
  });

  it("renders every returned file operation and text edit before apply", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );

    const plan = screen.getByRole("region", { name: "Mutation plan" });
    expect(plan).toHaveTextContent("create file");
    expect(plan).toHaveTextContent("notes/source.md");
    expect(plan).toHaveTextContent("notes/target.md");
    expect(plan).toHaveTextContent("[[Unresolved Target]]");
    expect(plan).toHaveTextContent("[[notes/target.md]]");
  });

  it("invalidates a create preview when its inputs change", async () => {
    mocks.issues = [createIssue];
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: /Missing Page/ }));
    await user.type(
      screen.getByRole("textbox", { name: "New page folder" }),
      "notes",
    );
    await user.click(
      screen.getByRole("button", { name: "Preview page creation" }),
    );
    expect(
      await screen.findByRole("button", { name: "Apply previewed repair" }),
    ).toBeVisible();

    await user.type(
      screen.getByRole("textbox", { name: "New page folder" }),
      "/new",
    );
    expect(
      screen.queryByRole("button", { name: "Apply previewed repair" }),
    ).not.toBeInTheDocument();
  });

  it("clears the old preview synchronously when a new preview starts", async () => {
    // Runtime supports ES2024; the app's current TS lib has not declared it yet.
    const promiseConstructor = Promise as unknown as PromiseConstructor & {
      withResolvers<T>(): {
        promise: Promise<T>;
        resolve: (value: T) => void;
      };
    };
    const { promise: second, resolve: resolveSecond } =
      promiseConstructor.withResolvers<unknown>();
    mocks.issues = [
      {
        ...unresolvedIssue,
        candidates: [
          ...unresolvedIssue.candidates,
          {
            page_id: "candidate-2",
            path: "notes/other.md",
            title: "Other",
            rationale: "Nearby title",
          },
        ],
      },
    ];
    mocks.preview
      .mockResolvedValueOnce({
        fingerprint: "unresolved-1",
        before: "old",
        after: "first",
        plan: { file_ops: [], text_edits: [] },
      })
      .mockReturnValueOnce(second);
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );
    expect(await screen.findByText("first")).toBeVisible();

    await user.click(
      screen.getByRole("button", { name: "Replace with notes/other.md" }),
    );
    expect(screen.queryByText("first")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Apply previewed repair" }),
    ).not.toBeInTheDocument();
    resolveSecond({
      fingerprint: "unresolved-1",
      before: "old",
      after: "second",
      plan: { file_ops: [], text_edits: [] },
    });
  });

  it("pages the complete result set and resets pagination on filters", async () => {
    mocks.total = 250;
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    renderWorkspace({ onFiltersChange });
    expect(screen.getByText("1–100 of 250")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ offset: 100, limit: 100 }),
    );

    await user.type(screen.getByRole("textbox", { name: "Project" }), "Atlas");
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ project: "Atlas", offset: 0 }),
    );
  });

  it("clamps a deep-linked empty page to the last valid offset", async () => {
    mocks.issues = [];
    mocks.total = 250;
    const onFiltersChange = vi.fn();
    renderWorkspace({
      filters: { limit: 100, offset: 4294967200 },
      onFiltersChange,
    });

    await waitFor(() =>
      expect(onFiltersChange).toHaveBeenCalledWith({
        limit: 100,
        offset: 200,
      }),
    );
  });

  it("returns from an emptied final page after apply invalidation", async () => {
    mocks.total = 201;
    const onFiltersChange = vi.fn();
    const user = userEvent.setup();
    const { rerender } = renderWorkspace({
      filters: { limit: 100, offset: 200 },
      onFiltersChange,
    });
    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply previewed repair" }),
    );

    mocks.issues = [];
    mocks.total = 200;
    rerender(
      <RepairWorkspace
        filters={{ limit: 100, offset: 200 }}
        onFiltersChange={onFiltersChange}
      />,
    );
    await waitFor(() =>
      expect(onFiltersChange).toHaveBeenCalledWith({
        limit: 100,
        offset: 100,
      }),
    );
  });

  it("describes topology issues without claiming their source is encrypted", async () => {
    mocks.issues = [orphanIssue];
    const user = userEvent.setup();
    renderWorkspace();
    await user.click(screen.getByRole("button", { name: /Source Note/ }));

    expect(screen.getByText(/no incoming references/i)).toBeVisible();
    expect(
      screen.queryByText(/protected or encrypted/i),
    ).not.toBeInTheDocument();
  });

  it("does not focus the selected desktop row before authoritative refresh", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const row = screen.getByRole("button", { name: /Unresolved Target/ });

    await user.click(row);
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply previewed repair" }),
    );

    expect(row).not.toHaveFocus();
  });

  it("waits for authoritative desktop removal before focusing the first remaining row", async () => {
    const user = userEvent.setup();
    mocks.issues = [unresolvedIssue, ambiguousIssue];
    mocks.total = 2;
    mocks.refetchGate = deferred<unknown>();
    const { rerender } = renderWorkspace();
    const appliedRow = screen.getByRole("button", {
      name: /Unresolved Target/,
    });

    await user.click(appliedRow);
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply previewed repair" }),
    );

    expect(appliedRow).not.toHaveFocus();
    mocks.issues = [ambiguousIssue];
    mocks.total = 1;
    mocks.refetchGate.resolve(undefined);
    await mocks.refetchGate.promise;
    mocks.refetchGate = null;
    rerender(<RepairWorkspace />);

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /Second Target/ }),
      ).toHaveFocus(),
    );
  });

  it("does not steal focus when another issue is selected during a pending apply", async () => {
    const user = userEvent.setup();
    const applyGate = deferred<unknown>();
    mocks.apply.mockReturnValue(applyGate.promise);
    mocks.refetchGate = deferred<unknown>();
    mocks.issues = [unresolvedIssue, ambiguousIssue];
    mocks.total = 2;
    const { rerender } = renderWorkspace();
    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply previewed repair" }),
    );

    const otherRow = screen.getByRole("button", { name: /Second Target/ });
    await user.click(otherRow);
    applyGate.resolve({
      fingerprint: unresolvedIssue.fingerprint,
      notification: { message: "Repair applied" },
    });
    mocks.issues = [ambiguousIssue];
    mocks.total = 1;
    mocks.refetchGate.resolve(undefined);
    await mocks.refetchGate.promise;
    mocks.refetchGate = null;
    rerender(<RepairWorkspace />);

    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Second Target" }),
      ).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: /Second Target/ })).toHaveFocus();
  });

  it("opens issue detail in the shared dialog on mobile", async () => {
    mocks.mobile = true;
    const user = userEvent.setup();

    renderWorkspace();

    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));

    const dialog = screen.getByRole("dialog", { name: "Repair issue" });
    expect(dialog).toBeVisible();
    expect(within(dialog).getByText("notes/source.md")).toBeVisible();
  });

  it("closes mobile detail after apply and restores row focus", async () => {
    mocks.mobile = true;
    const user = userEvent.setup();
    renderWorkspace();
    const row = screen.getByRole("button", { name: /Unresolved Target/ });
    await user.click(row);
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply previewed repair" }),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Repair issue" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(row).toHaveFocus());
  });

  it("moves focus to the results status when an applied mobile issue leaves the ledger", async () => {
    mocks.mobile = true;
    const user = userEvent.setup();
    mocks.refetchGate = deferred<unknown>();
    const { rerender } = renderWorkspace();
    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Apply previewed repair" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Repair issue" }),
      ).not.toBeInTheDocument(),
    );

    mocks.issues = [];
    mocks.total = 0;
    mocks.refetchGate.resolve(undefined);
    await mocks.refetchGate.promise;
    mocks.refetchGate = null;
    rerender(<RepairWorkspace />);

    await waitFor(() =>
      expect(
        screen.getByRole("status", { name: "Reference repair results" }),
      ).toHaveFocus(),
    );
  });
  it("keeps selection while a refreshed result is not yet available", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWorkspace();
    await user.click(screen.getByRole("button", { name: /Unresolved Target/ }));
    expect(
      screen.getByRole("heading", { name: "Unresolved Target" }),
    ).toBeVisible();

    mocks.hasData = false;
    mocks.isPending = true;
    rerender(<RepairWorkspace />);
    mocks.hasData = true;
    mocks.isPending = false;
    rerender(<RepairWorkspace />);

    expect(
      screen.getByRole("heading", { name: "Unresolved Target" }),
    ).toBeVisible();
  });

  it("explains a deep-linked target without hiding the issue ledger", () => {
    renderWorkspace({ target: "clepsydra://page/Unresolved Target" });

    expect(screen.getByRole("status")).toHaveTextContent(
      "clepsydra://page/Unresolved Target",
    );
    expect(
      screen.getByRole("list", { name: "Reference issues" }),
    ).toBeVisible();
  });

  it("renders explicit loading, error, and empty states", () => {
    mocks.isPending = true;
    const { rerender } = renderWorkspace();
    expect(screen.getByRole("status")).toHaveTextContent(
      /loading reference issues/i,
    );

    mocks.isPending = false;
    mocks.queryError = new Error("offline");
    rerender(<RepairWorkspace />);
    expect(screen.getByRole("alert")).toHaveTextContent(/could not load/i);

    mocks.queryError = null;
    mocks.issues = [];
    rerender(<RepairWorkspace />);
    expect(screen.getByText(/no reference issues match/i)).toBeVisible();
  });
});

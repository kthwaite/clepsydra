import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ReferenceRepairApiError, type ReferenceIssue } from "#/api/index";
import { RepairWorkspace } from "../RepairWorkspace";

const mocks = vi.hoisted(() => ({
  issues: [] as ReferenceIssue[],
  isPending: false,
  queryError: null as Error | null,
  preview: vi.fn(),
  apply: vi.fn(),
  refetch: vi.fn(),
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
    useReferenceIssues: () => ({
      data: mocks.queryError
        ? undefined
        : { items: mocks.issues, limit: 100, offset: 0, total: mocks.issues.length },
      isPending: mocks.isPending,
      isError: Boolean(mocks.queryError),
      error: mocks.queryError,
      refetch: mocks.refetch,
    }),
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
  mocks.preview.mockReset().mockResolvedValue({
    fingerprint: unresolvedIssue.fingerprint,
    before: "[[Unresolved Target]]",
    after: "[[notes/target.md]]",
    plan: { file_ops: [], text_edits: [] },
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
    expect(screen.getByText("[[notes/target.md]]")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Apply previewed repair" }));

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

    await user.click(screen.getByRole("checkbox", { name: "Actionable only" }));
    expect(onFiltersChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ actionable: true }),
    );
  });

  it("makes navigation-only protected issues explicit and opens their source", async () => {
    const user = userEvent.setup();
    mocks.issues = [navigationOnlyIssue];
    renderWorkspace();

    await user.click(screen.getByRole("button", { name: /Protected Target/ }));
    expect(screen.getByText(/repair is unavailable/i)).toBeVisible();
    expect(screen.getByText(/protected or encrypted/i)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Open source" }));
    expect(mocks.openTab).toHaveBeenCalledWith(
      "page",
      "private/encrypted.md",
      "Encrypted Note",
    );
  });

  it("refreshes and announces a stale 409 preview", async () => {
    
    mocks.preview.mockRejectedValueOnce(
      new ReferenceRepairApiError({ error: "stale reference" } as never, 409, ""),
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

  it("restores focus to the selected row after apply", async () => {
    const user = userEvent.setup();
    renderWorkspace();
    const row = screen.getByRole("button", { name: /Unresolved Target/ });

    await user.click(row);
    await user.click(
      screen.getByRole("button", { name: "Replace with notes/target.md" }),
    );
    await user.click(screen.getByRole("button", { name: "Apply previewed repair" }));

    await waitFor(() => expect(row).toHaveFocus());
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

  it("explains a deep-linked target without hiding the issue ledger", () => {
    renderWorkspace({ target: "clepsydra://page/Unresolved Target" });

    expect(screen.getByRole("status")).toHaveTextContent(
      "clepsydra://page/Unresolved Target",
    );
    expect(screen.getByRole("list", { name: "Reference issues" })).toBeVisible();
  });

  it("renders explicit loading, error, and empty states", () => {
    mocks.isPending = true;
    const { rerender } = renderWorkspace();
    expect(screen.getByRole("status")).toHaveTextContent(/loading reference issues/i);

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
